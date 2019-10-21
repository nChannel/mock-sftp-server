'use strict';

const constants = require('constants');
const fs = require('fs');
const ssh2 = require('ssh2');
const SFTPStream = require('ssh2-streams').SFTPStream;
const OPEN_MODE = ssh2.SFTP_OPEN_MODE;
const STATUS_CODE = ssh2.SFTP_STATUS_CODE;
const path = require('path').posix;
let debug = require('debug')('test: sftpServer');
const DEBUG_NOOP = function(msg) {};
const checksumStream = require('checksum-stream');
const devnull = require('dev-null');

const fixturesdir = `${process.cwd()}/node_modules/ssh2/test/fixtures`;
const HOST_KEY_RSA = fs.readFileSync(`${fixturesdir}/ssh_host_rsa_key`);


exports.sftpServer = (opts, fn) => {
  let pathsOpened = [];
  let computedFileProperties = {};
  let renamedFiles = {};
  let directoriesCreated = [];
  let directoriesRemoved = [];

  const port = opts.port || 4000;
  debug = opts.debug? debug : DEBUG_NOOP;
  const initialStructure = JSON.parse(JSON.stringify(opts.initialStructure)) || {};
  let rootStructure = JSON.parse(JSON.stringify(initialStructure));
  const mockServer = new ssh2.Server({
    hostKeys: [{ key: HOST_KEY_RSA }],
    privateKey: HOST_KEY_RSA
  }, client => {
    debug('Client Connected');
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'foo' && ctx.password === 'bar') ctx.accept();
      else ctx.reject();
    });

    client.on('ready', () => {
      debug('Client authenticated');
      client.on('session', (accept, reject) => {
        const session = accept();
        let checksumS;
        session.on('sftp', (accept, reject) => {
          debug('Client SFTP session');
          let openFiles = [];
          let handleCount = 0;
          const sftpStream = accept();
          let calledReadDir = {};   // per-dirPath
          sftpStream.on('OPENDIR', (reqid, path) => {
            try {
              debug(path);
              const structureData = getStructureData(path);
              if (typeof(structureData) !== 'object') {
                sftpStream.status(reqid, STATUS_CODE.FAILURE);
              }
              const handle = Buffer.from(path);
              debug(handle);
              sftpStream.handle(reqid, handle);
            } catch (err) {
              sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }
          });
          sftpStream.on('OPEN', (reqid, filePath, flags, attrs) => {
            try {
              debug('Open');
              filePath = path.normalize(filePath);
              const flagsStr = SFTPStream.flagsToString(flags);
              switch (flagsStr) {
                case 'r':   // file must exist
                case 'r+':
                case 'rs+':
                  const structureData = getStructureData(filePath);
                  if (structureData !== true) {   // file, not directory
                    throw new Error("Can't open directory")
                  }
                 break;
                case 'ax':   // file must not exist
                case 'ax+':
                case 'wx':
                case 'wx+':
                  try {
                    const structureData = getStructureData(filePath);
                    throw new Error("file can't already exist");
                  } catch (err) {
                    // success
                  }
                  break;
              }
              setStructureData(filePath, true);

              const handle = Buffer.alloc(4);
              const handleNum = handleCount;
              openFiles[handleNum] = true;
              pathsOpened.push(filePath);
              computedFileProperties[filePath] = {};
              handle.writeUInt32BE(handleCount++, 0, true);
              sftpStream.handle(reqid, handle);
              debug('Opening file for read or write');
              checksumS = checksumStream({algorithm: 'sha256'});
              checksumS.on('digest', digest => {
                computedFileProperties[filePath].sha256 = digest;
              });
              checksumS.on('size', size => {
                computedFileProperties[filePath].size = size;
              }).pipe(devnull())
            } catch (err) {
              sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }
          });
          sftpStream.on('WRITE', (reqid, handle, offset, data) => {
            if (handle.length !== 4 || !openFiles[handle.readUInt32BE(0, true)])
              return sftpStream.status(reqid, STATUS_CODE.FAILURE);
            const canWriteMore = checksumS.write(data, err => {
              sftpStream.status(reqid, STATUS_CODE.OK);
            });
             const inspected = require('util').inspect(data);
            debug('Write to file at offset %d: %s', offset, inspected);
          });
          sftpStream.on('READ', (reqid, handle, offset, length) => {
            if (handle.length !== 4 || !openFiles[handle.readUInt32BE(0, true)])
              return sftpStream.status(reqid, STATUS_CODE.FAILURE);
            let state = {};
            if (state.read)
              sftpStream.status(reqid, STATUS_CODE.EOF);
            else {
              debug(state);
              state.read = true;
              sftpStream.data(reqid, 'bar');
              debug('Read from file at offset %d, length %d', offset, length);
            }
          });
          sftpStream.on('READDIR', (reqid, handle) => {
            try {
              debug('trying to list');
              debug(calledReadDir);
              debug(handle);
              debug(handle.toString());
              const dirPath = path.normalize(handle.toString());
              if (!calledReadDir[dirPath]) {
                calledReadDir[dirPath] = true;
                generateListing(rootStructure, dirPath.split('/'), list => {
                  sftpStream.name(reqid, list);
                });
              } else {
                sftpStream.status(reqid, STATUS_CODE.EOF);
              }
            } catch (err) {
              sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }
          });
          sftpStream.on('MKDIR', (reqid, path) => {
            if (path.length > 0) {
              setStructureData(path, {});
              directoriesCreated.push(path);
              sftpStream.status(reqid, STATUS_CODE.OK);
            } else {
              sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }
          });
          sftpStream.on('RMDIR', (reqid, path) => {
            if (path.length > 0) {
              // TODO: check that directory is empty
              try {
                const structureData = getStructureData(path);
                if (typeof structureData !== 'object') {   // it's a file, not a directory
                  sftpStream.status(reqid, STATUS_CODE.FAILURE);
                  return;
                }
              } catch (err) {
                // it's okay if the directory doesn't exist
              }
              setStructureData(path, null);
              directoriesRemoved.push(path);
              sftpStream.status(reqid, STATUS_CODE.OK);
            } else {
              sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }
          });
          sftpStream.on('REALPATH', (reqid, path) => {
            const name = [{
              filename: '/tmp/foo.txt',
              longname: '-rwxrwxrwx 1 foo foo 3 Dec 8 2009 foo.txt',
              attrs: {}
            }];
            sftpStream.name(reqid, name);
          });
          sftpStream.on('STAT', onSTAT);
          sftpStream.on('LSTAT', onSTAT);
          sftpStream.on('CLOSE', (reqid, handle) => {
            if (checksumS) {
              checksumS.end();
            }
            sftpStream.status(reqid, STATUS_CODE.OK);
            debug('Closing file');
          });
          sftpStream.on('REMOVE', (reqid, path) => {
            try {
              const structureData = getStructureData(path);
              if (typeof structureData === 'object') {
                sftpStream.status(reqid, STATUS_CODE.FAILURE);
                return;
              }
            } catch (err) {
              // it's okay if the file doesn't exist
            }
            setStructureData(path, false);
            sftpStream.status(reqid, STATUS_CODE.OK);
          });
          sftpStream.on('RENAME', (reqid, oldPath, newPath) => {
            try {
              const relPath = path.relative('', newPath);
              if (relPath.startsWith('..')) {
                sftpStream.status(reqid, STATUS_CODE.FAILURE);
                return;
              }
              const structureData = getStructureData(oldPath);
              setStructureData(oldPath, false);
              setStructureData(newPath, structureData);
              renamedFiles[oldPath] = newPath;
              sftpStream.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }
          });

          function getStructureData(path) {
            let structure;
            _traverseStructure(rootStructure, path.split('/'), struct => {
              structure = struct;
            });
            return structure;
          }

          /**
           * Sets or removes structure data for a path
           * @param path
           * @param data pass false to remove data
           */
          function setStructureData(path, data) {
            const names = path.split('/');
            if (names.length === 1 && (names[0] === '' || names[0] === '.')) {
              throw new Error("Can't modify root directory")
            }
            const fileName = names[names.length-1];
            let directoryPath = names.slice(0, names.length-1).join('/');
            const directoryData = getStructureData(directoryPath);
            if (data !== false) {
              directoryData[fileName] = data;
            } else {
              delete directoryData[fileName];
            }
          }

          /**
           * Recurses through the structure to find the data for a path.
           * @param structure the directory structure or a sub-part
           * @param names path as an array of strings
           * @param callback function accepting structure data
           * @private
           * @throws error if path does not exist
           */
          function _traverseStructure(structure, names, callback) {
            if (names.length === 1 && (names[0] === '' || names[0] === '.')) {
              names = [];
            }
            if (names.length) {
              if (!structure[names[0]]) {
                throw new Error(`"${names[0]}" does not exist`)
              } else {
                return _traverseStructure(structure[names[0]], names.slice(1), callback);
              }
            }

            callback(structure);
          }

          function onSTAT(reqid, path) {
            try {
              const structureData = getStructureData(path);

              let mode = constants.S_IFREG; // Regular file
              mode |= constants.S_IRWXU; // read, write, execute for user
              mode |= constants.S_IRWXG; // read, write, execute for group
              mode |= constants.S_IRWXO; // read, write, execute for other
              sftpStream.attrs(reqid, {
                mode: mode,
                uid: 0,
                gid: 0,
                size: 3,
                atime: Date.now(),
                mtime: Date.now()
              });
            } catch (err) {
              sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }
          }

          function generateListing(structure, names, fn) {
            if (names.length === 1 && (names[0] === '' || names[0] === '.')) {
              names = [];
            }
            if (names.length) {
              if (!structure[names[0]]) {
                throw new Error(`"${names[0]}" does not exist`)
              } else {
                return generateListing(structure[names[0]], names.slice(1),fn);
              }
            }

            const list = [];
            for (let name in structure) {
              if (typeof(structure[name]) === 'object') {   // TODO: how do we indicate it's a directory?
                list.push({filename: name, longname: name, attrs: {size: 69}});
              } else {
                list.push({filename: name, longname: name, attrs: {size: 42}});
              }
            }
            return fn(list);
          }
        });
      });
    });

    client.on('end', () => {
      debug('Client disconnected');
    });

    client.on('close', () => {
      debug('Connection closed');
    });
    client.on('error', err => {
      debug('server error:', err);
    });
  }).listen(opts.port, '127.0.0.1', function() {
    debug('Listening on port ' + this.address().port);
    fn();
  });

  mockServer.reset = () => {
    rootStructure = JSON.parse(JSON.stringify(initialStructure));
    pathsOpened = [];
    computedFileProperties = {};
    renamedFiles = {};
    directoriesCreated = [];
    directoriesRemoved = [];
  };

  mockServer.getPathsOpened = () => {
    return pathsOpened.slice(0);
  };
  mockServer.computedFileSize = path => {
    if (computedFileProperties[path]) {
      return computedFileProperties[path].size;
    } else {
      throw new RangeError("never sent " + path)
    }
  };
  mockServer.computedSha256 = path => {
    if (computedFileProperties[path]) {
      return computedFileProperties[path].sha256;
    } else {
      throw new RangeError("never sent " + path)
    }
  };

  mockServer.getRenamedFiles = () => {
    return Object.assign({}, renamedFiles);   // shallow clone
  };

  mockServer.getDirectoriesCreated = () => {
    return directoriesCreated.slice(0);
  };

  mockServer.getDirectoriesRemoved = () => {
    return directoriesRemoved.slice(0);
  };

  return mockServer;
};
