'use strict';

const assert = require('assert');
const expect = require('chai').expect;
const SFTP = require('../sftpServer');
const ssh2 = require('ssh2');
const STATUS_CODE = ssh2.SFTP_STATUS_CODE;

const connOpts = {
  host: '127.0.0.1',
  port: 4000,
  username: 'foo',
  password: 'bar',
  debug: false
};

const initialStructure = {
  'foo': {
    'bar': true,
    'baz': {
    }
  },
  'corge': {
    'frotz': {
      'grault': true
    }
  },
  'outer': {
    'inner': {
    }
  }
};
const debug = false;
const port = 4000;

describe('Mock SFTP Server', () => {
  let  mockServer;
  const client = new ssh2();
  let sftp;

  before(done => {
    mockServer = SFTP.sftpServer({ initialStructure, debug, port }, done);
  });

  after(done => {
    client.end();
    mockServer.close((err) => {
      if (err) {
        console.error("mock server closed:", err);
      }
      done();
    });
  });

  describe('computedFileSize', () => {
    it('should throw intelligible error when no file has been sent to path', () => {
      mockServer.reset();
      expect(() => mockServer.computedFileSize('/frobotz')).to.throw(RangeError, "never sent");
    });
  });

  describe('computedSha256', () => {
    it('should throw intelligible error when no file has been sent to path', () => {
      mockServer.reset();
      expect(() => mockServer.computedSha256('/frobotz')).to.throw(RangeError, "never sent");
    });
  });

  describe('Connection to mock server', () => {
    let error, connected = false;
    before(done => {
      mockServer.reset();
      client.connect(connOpts);

      client.on('error', err => {
        error = err;
        return done();
      });

      client.on('ready', () => {
        client.sftp((err, sftpConn) => {
          if (err) {
            error = err;
            return done();
          }
          if (!sftpConn) {
            error = new Error('No SFTP');
            return done();
          }
          connected = true;
          sftp = sftpConn;
          done();
        });
      });
    });

    it('should connect without error', done => {
      expect(error).to.not.exist;
      done();
    });

    it('should be connected', done => {
      expect(connected).to.be.true;
      done();
    });

  });

  describe('exists', () => {
    it('should return true for existing files', done => {
      mockServer.reset();
      sftp.exists('foo/bar', isExisting => {
        expect(isExisting).to.equal(true);
        done();
      });
    });

    it('should return true for existing directories with trailing slash', done => {
      mockServer.reset();
      sftp.exists('foo/baz/', isExisting => {
        expect(isExisting).to.equal(true);
        done();
      });
    });

    it('should return false for non-existing files', done => {
      mockServer.reset();
      sftp.exists('sir/not/appearing/in/this/scene', isExisting => {
        expect(isExisting).to.equal(false);
        done();
      });
    });
  });

  describe('reading', () => {
    it('should error when downloading a non-existing file', done => {
      mockServer.reset();
      sftp.fastGet('not-there', 'test/downloads/downloaded-not-there', err => {
        expect(err).to.exist;
        const openedDuring = mockServer.getPathsOpened();
        expect(openedDuring).to.deep.equal([]);
        done();
      });
    });

    it('should download a file without error', done => {
      mockServer.reset();
      sftp.fastGet('foo/bar', 'test/downloads/downloaded-bar', err => {
        expect(err).to.not.exist;
        const openedDuring = mockServer.getPathsOpened();
        expect(openedDuring).to.deep.equal(['foo/bar']);
        done();
      });
    });

    it('should stream data from file that exists', done => {
      mockServer.reset();
      let totalBytes = 0;
      const stream = sftp.createReadStream('foo/bar', {encoding: 'utf8'});
      stream.on('data', chunk => {
        totalBytes += chunk.length;
        expect(chunk).to.equal("bar");
      });
      stream.on('end', () => {
        expect(totalBytes).to.equal(6);
        const openedDuring = mockServer.getPathsOpened();
        expect(openedDuring).to.deep.equal(['foo/bar']);
        done();
      })
    });
  });


  describe('fastPut', () => {
    it('should upload file without error', done => {
      mockServer.reset();
      sftp.fastPut(`${process.cwd()}/test/fixtures/bar`, 'spam', err => {
        expect(err).to.not.exist;
        const openedDuring = mockServer.getPathsOpened();
        expect(openedDuring).to.deep.equal(['spam']);
        expect(mockServer.computedFileSize('spam')).to.equal(89);
        expect(mockServer.computedSha256('spam')).to.equal('065213cd0a07312fc8fac06d75dc09f2b34dfb0824fb241dc34763d811a4114c');

        sftp.exists('spam', isExisting => {
          expect(isExisting).to.equal(true);
          done();
        });
      });
    });
  });

  describe('readdir', () => {
    it('should read an existing directory', done => {
      mockServer.reset();
      sftp.readdir('foo', (error, list) => {
        expect(error).to.not.exist;
        expect(list.length).to.equal(2);
        expect(list[0].filename).to.equal("bar");
        expect(list[1].filename).to.equal("baz");
        done();
      });
    });

    it('should read an existing directory with trailing slash', done => {
      mockServer.reset();
      sftp.readdir('foo/', (error, list) => {
        expect(error).to.not.exist;
        expect(list.length).to.equal(2);
        expect(list[0].filename).to.equal("bar");
        expect(list[1].filename).to.equal("baz");
        done();
      });
    });

    it('should fail to read a non-existent directory', done => {
      mockServer.reset();
      sftp.readdir('notThere', (error, list) => {
        expect(error).to.exist;
        expect(list).to.not.exist;
        done();
      });
    });

    it('should read a nested directories', done => {
      mockServer.reset();
      sftp.readdir('corge/frotz/', (error, list) => {
        expect(error).to.not.exist;
        expect(list.length).to.equal(1);
        expect(list[0].filename).to.equal("grault");
        done();
      });
    });

    it('should read top-level directory', done => {
      mockServer.reset();
      sftp.readdir('', (error, list) => {
        expect(error).to.not.exist;
        expect(list.length).to.equal(3);
        expect(list[0].filename).to.equal("foo");
        expect(list[1].filename).to.equal("corge");
        expect(list[2].filename).to.equal("outer");
        done();
      });
    });
  });

  describe('mkdir', () => {
    it('should succeed when passed valid path', done => {
      mockServer.reset();
      sftp.mkdir('quux', err => {
        expect(err).to.not.exist;
        const createdDuring = mockServer.getDirectoriesCreated();
        expect(createdDuring).to.deep.equal(['quux']);

        sftp.readdir('quux', (error, list) => {
          expect(error).to.not.exist;
          expect(list.length).to.equal(0);
          done();
        });
      });
    });
    it('should succeed when passed valid path with trailing slash', done => {
      mockServer.reset();
      sftp.mkdir('greeble/', err => {
        expect(err).to.not.exist;
        const createdDuring = mockServer.getDirectoriesCreated();
        expect(createdDuring).to.deep.equal(['greeble']);

        sftp.readdir('greeble', (error, list) => {
          expect(error).to.not.exist;
          expect(list.length).to.equal(0);
          done();
        });
      });
    });
    it('should return error when passed zero-length string', done => {
      mockServer.reset();
      sftp.mkdir('', err => {
        expect(err).to.exist;
        const createdDuring = mockServer.getDirectoriesCreated();
        expect(createdDuring).to.deep.equal([]);
        done();
      });
    });
  });

  describe('rmdir', () => {
    it('should succeed when passed empty directory', done => {
      mockServer.reset();
      sftp.rmdir('foo/baz', err => {
        expect(err).to.not.exist;
        const removedDuring = mockServer.getDirectoriesRemoved();
        expect(removedDuring).to.deep.equal(['foo/baz']);

        sftp.exists('foo/baz', isExisting => {
          expect(isExisting).to.equal(false);
          done();
        });
      });
    });
    it('should succeed when passed empty directory with trailing slash', done => {
      mockServer.reset();
      sftp.rmdir('foo/baz/', err => {
        expect(err).to.not.exist;
        const removedDuring = mockServer.getDirectoriesRemoved();
        expect(removedDuring).to.deep.equal(['foo/baz']);

        sftp.exists('foo/baz', isExisting => {
          expect(isExisting).to.equal(false);
          done();
        });
      });
    });
    it('should succeed when deleting empty hierarchy', done => {
      mockServer.reset();
      sftp.rmdir('outer/inner', err => {
        expect(err).to.not.exist;
        const removedDuring = mockServer.getDirectoriesRemoved();
        expect(removedDuring).to.deep.equal(['outer/inner']);

        sftp.exists('outer/inner', isExisting => {
          expect(isExisting).to.equal(false);

          sftp.rmdir('outer', err => {
            expect(err).to.not.exist;
            const removedDuring = mockServer.getDirectoriesRemoved();
            expect(removedDuring).to.deep.equal(['outer/inner', 'outer']);

            sftp.exists('outer', isExisting => {
              expect(isExisting).to.equal(false);
              done();
            })
          });
        });
      });
    });
    it('should return error when passed zero-length string', done => {
      mockServer.reset();
      sftp.rmdir('', err => {
        expect(err).to.exist;
        const removedDuring = mockServer.getDirectoriesRemoved();
        expect(removedDuring).to.deep.equal([]);
        done();
      });
    });
  });

  describe('unlink', () => {
    it('should remove a remote file without error', done => {
      mockServer.reset();
      sftp.unlink('foo/bar', err => {
        expect(err).to.not.exist;

        sftp.exists('foo/bar', isExisting => {
          expect(isExisting).to.equal(false);
          done();
        });
      });
    });
  });

  describe('rename', () => {
    it('should error when asked to rename to a parent directory', done => {
      mockServer.reset();
      sftp.rename('corge/frotz/grault', '../grault', err => {
        expect(err.code).to.equal(STATUS_CODE.FAILURE);
        expect(mockServer.getRenamedFiles()).to.deep.equal({});

        sftp.exists('corge/frotz/grault', isExisting => {
          expect(isExisting).to.equal(true);
          sftp.exists('corge/grault', isExisting => {
            expect(isExisting).to.equal(false);
            done();
          });
        });
      });
    });

    it('should rename a remote file without error', done => {
      mockServer.reset();
      sftp.rename('corge/frotz/grault', 'corge/grault', err => {
        expect(err).to.not.exist;
        expect(mockServer.getRenamedFiles()).to.deep.equal({'corge/frotz/grault': 'corge/grault'});

        sftp.exists('corge/frotz/grault', isExisting => {
          expect(isExisting).to.equal(false);
          sftp.exists('corge/grault', isExisting => {
            expect(isExisting).to.equal(true);
            done();
          });
        });
      });
    });

    it('should error when asked to rename a non-existent file', done => {
      mockServer.reset();
      sftp.rename('corge/notThere', 'foo/notThere', err => {
        expect(err.code).to.equal(STATUS_CODE.FAILURE);
        expect(mockServer.getRenamedFiles()).to.deep.equal({});

        sftp.exists('corge/notThere', isExisting => {
          expect(isExisting).to.equal(false);
          sftp.exists('foo/notThere', isExisting => {
            expect(isExisting).to.equal(false);
            done();
          });
        });
      });
    });
  });
});