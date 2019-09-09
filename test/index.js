// TODO: restart server for each test

'use strict';

const assert = require('assert');
const expect = require('chai').expect;
const SFTP = require('../sftpServer');
const Client = require('ssh2');

const connOpts = {
  host: '127.0.0.1',
  port: 4000,
  username: 'foo',
  password: 'bar',
  debug: false
};

const listing = [
  {
    '/foo': [
      { filename: 'bar', attrs: {} },
      { filename: 'not.afile', attrs: {} }
    ]
  },
  {
    '/bar': [
      { filename: 'foo', attrs: {} }
    ]
  }
];
const debug = false;
const port = 4000;

describe('Mock SFTP Server', () => {
  let  mockServer;
  const client = new Client();
  let sftp;

  before(done => {
    mockServer = SFTP.sftpServer({ listing, debug, port }, done);
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
      expect(() => mockServer.computedFileSize('/frobotz')).to.throw(RangeError, "never sent");
    });
  });

  describe('computedSha256', () => {
    it('should throw intelligible error when no file has been sent to path', () => {
      expect(() => mockServer.computedSha256('/frobotz')).to.throw(RangeError, "never sent");
    });
  });

  describe('Connection to mock server', () => {
    let error, connected = false;
    before(done => {
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

  describe('fastGet', () => {
    it('should download a file without error', done => {
      const openedBefore = mockServer.getPathsOpened();
      sftp.fastGet('/foo', 'bar', err => {
        expect(err).to.not.exist;
        const openedDuring = mockServer.getPathsOpened().slice(openedBefore.length);
        expect(openedDuring).to.deep.equal(['/foo']);
        done();
      });
    });
  });

  describe('fastPut', () => {
    it('should upload file without error', done => {
      const openedBefore = mockServer.getPathsOpened();
      sftp.fastPut(`${process.cwd()}/test/fixtures/bar`, '/spam', err => {
        expect(err).to.not.exist;
        const openedDuring = mockServer.getPathsOpened().slice(openedBefore.length);
        expect(openedDuring).to.deep.equal(['/spam']);
        expect(mockServer.computedFileSize('/spam')).to.equal(89);
        expect(mockServer.computedSha256('/spam')).to.equal('065213cd0a07312fc8fac06d75dc09f2b34dfb0824fb241dc34763d811a4114c');
        done();
      });
    });
  });

  describe('readdir', () => {
    let error, results;
    before(done => {
      sftp.readdir('/foo', (err, list) => {
        error = err;
        results = list;
        done();
      });
    });

    it('should read a directory without issue', done => {
      expect(error).to.not.exist;
      done();
    });

    it('should return results', done => {
      expect(results).to.exist;
      done();
    });
  });

  describe('unlink', () => {
    it('should remove a remote file without error', done => {
      sftp.unlink('/foo/bar', err => {
        expect(err).to.not.exist;
        done();
      });
    });
  });

  describe('rename', () => {
    it('should rename a remote file without error', done => {
      sftp.rename('/kung/bar', '/kung/foo', err => {
        expect(err).to.not.exist;
        done();
      });
    });
  });
});