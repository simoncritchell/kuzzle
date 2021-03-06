'use strict';

const rewire = require('rewire');
const Bluebird = require('bluebird');
const should = require('should');
const sinon = require('sinon');
const KuzzleMock = require('../../../mocks/kuzzle.mock');
const {
  Request,
  errors: {
    BadRequestError,
    NotFoundError,
    PluginImplementationError,
    SizeLimitError,
    PreconditionError
  }
} = require('kuzzle-common-objects');
const SecurityController = rewire('../../../../lib/api/controller/security');

describe('Test: security controller - users', () => {
  let kuzzle;
  let request;
  let securityController;

  beforeEach(() => {
    kuzzle = new KuzzleMock();
    securityController = new SecurityController(kuzzle);
    request = new Request({controller: 'security'});
    kuzzle.internalIndex.getMapping.resolves({internalIndex: {mappings: {users: {properties: {}}}}});
    kuzzle.internalIndex.get.resolves({});
  });

  describe('#updateUserMapping', () => {
    const foo = {foo: 'bar'};

    it('should throw a BadRequestError if the body is missing', () => {
      return should(() => {
        securityController.updateUserMapping(request);
      }).throw(BadRequestError, { id: 'api.assert.body_required'});
    });

    it('should update the user mapping', () => {
      request.input.body = foo;
      kuzzle.internalIndex.updateMapping.resolves(foo);

      return securityController.updateUserMapping(request)
        .then(response => {
          should(kuzzle.internalIndex.updateMapping)
            .be.calledOnce()
            .be.calledWith('users', request.input.body);

          should(response).be.instanceof(Object);
          should(response).match(foo);
        });
    });
  });

  describe('#getUserMapping', () => {
    it('should fulfill with a response object', () => {
      kuzzle.internalIndex.getMapping.resolves({ properties: { foo: 'bar' } });

      return securityController.getUserMapping(request)
        .then(response => {
          should(kuzzle.internalIndex.getMapping)
            .be.calledOnce()
            .be.calledWith('users');

          should(response).be.instanceof(Object);
          should(response).match({ mapping: { foo: 'bar' } });
        });
    });
  });

  describe('#getUser', () => {
    it('should throw an error if no id is given', () => {
      return should(() => {
        securityController.getUser(new Request({}));
      }).throw(BadRequestError, {
        id: 'api.assert.missing_argument',
        message: 'Missing argument "_id".'});
    });

    it('should reject with NotFoundError when the user is not found', () => {
      kuzzle.repositories.user.load.resolves(null);

      return should(securityController.getUser(new Request({_id: 'i.dont.exist'})))
        .be.rejectedWith(NotFoundError, { id: 'security.user.not_found'});
    });
  });

  describe('#mGetUsers', () => {
    it('should throw an error if no ids are given', () => {
      return should(() => securityController.mGetUsers(new Request({}))
        .throw(BadRequestError, {
          id: 'api.assert.missing_argument',
          message: 'Missing argument "ids".'}));
    });

    it('should not throw if ids are given as a body array', () => {
      kuzzle.repositories.user.loadMultiFromDatabase.resolves([
        {_id: 'test', profileIds: ['profile1']}
      ]);

      should(securityController.mGetUsers(new Request({
        body: {
          ids: ['user1', 'user2']
        }
      }))).not.throw();
    });

    it('should not throw if ids are given as string', () => {
      kuzzle.repositories.user.loadMultiFromDatabase.resolves([
        { _id: 'test', profileIds: ['profile1'] }
      ]);

      should(securityController.mGetUsers(new Request({
        ids: 'user1,user2'
      }
      ))).not.throw();
    });
  });

  describe('#searchUsers', () => {
    it('should return a valid responseObject', () => {
      request = new Request({
        body: { query: {foo: 'bar' }},
        from: 13,
        size: 42,
        scroll: 'foo'
      });

      kuzzle.repositories.user.search.resolves({
        hits: [{ _id: 'admin', _source: { profileIds: ['admin'] } }],
        total: 2,
        scrollId: 'foobar'
      });

      return securityController.searchUsers(request)
        .then(response => {
          should(kuzzle.repositories.user.search).be.calledWithMatch({query: {foo: 'bar'}}, {from: 13, size: 42, scroll: 'foo'});
          should(response).be.instanceof(Object);
          should(response).match({hits: [{_id: 'admin'}], total: 2, scrollId: 'foobar'});
        });
    });

    it('should handle empty body requests', () => {
      kuzzle.repositories.user.search.resolves({
        hits: [{ _id: 'admin', _source: { profileIds: ['admin'] } }],
        total: 2,
        scrollId: 'foobar'
      });

      return securityController.searchUsers(new Request({}))
        .then(response => {
          should(kuzzle.repositories.user.search).be.calledWithMatch({}, {});
          should(response).be.instanceof(Object);
          should(response).match({hits: [{_id: 'admin'}], total: 2, scrollId: 'foobar'});
        });
    });

    it('should pass allowed `aggregations` and `highlight` arguments', () => {
      kuzzle.repositories.user.search.resolves({
        hits: [{ _id: 'admin', _source: { profileIds: ['admin'] } }],
        total: 2,
        scrollId: 'foobar'
      });

      request = new Request({
        body: {
          aggregations: 'aggregations'
        }
      });

      return securityController.searchUsers(request)
        .then(() => {
          should(kuzzle.repositories.user.search)
            .be.calledWithMatch({ aggregations: 'aggregations' });

          // highlight only
          return securityController.searchUsers(new Request({
            body: {
              highlight: 'highlight'
            }
          }));
        })
        .then(() => {
          should(kuzzle.repositories.user.search)
            .be.calledWithMatch({ highlight: 'highlight' });

          // all in one
          return securityController.searchUsers(new Request({
            body: {
              query: { match_all: {} },
              aggregations: 'aggregations',
              highlight: 'highlight'
            }
          }));
        })
        .then(() => {
          should(kuzzle.repositories.user.search).be.calledWithMatch(
            {
              aggregations: 'aggregations',
              highlight: 'highlight',
              query: { match_all: {} },
            });
        });
    });

    it('should throw an error if the number of documents per page exceeds server limits', () => {
      kuzzle.config.limits.documentsFetchCount = 1;

      request = new Request({
        body: {policies: ['role1']},
        from: 0,
        size: 10
      });

      return should(() => securityController.searchUsers(request))
        .throw(SizeLimitError, { id: 'services.storage.get_limit_exceeded' });
    });

    it('should reject an error in case of error', () => {
      const error = new Error('Mocked error');
      kuzzle.repositories.user.search.rejects(error);

      return should(securityController.searchUsers(new Request({body: {}})))
        .be.rejectedWith(error);
    });
  });

  describe('#scrollUsers', () => {
    it('should throw if no scrollId is provided', () => {
      should(() => securityController.scrollUsers(new Request({controller: 'security', action: 'scrollUsers'})))
        .throw(BadRequestError, {
          id: 'api.assert.missing_argument',
          message: 'Missing argument "scrollId".'
        });
    });

    it('should reformat search results correctly', () => {
      request = new Request({scrollId: 'foobar'});

      kuzzle.repositories.user.scroll.resolves({
        hits: [{ _id: 'admin', _source: { profileIds: ['admin'] } }],
        total: 2,
        scrollId: 'foobar'
      });

      return securityController.scrollUsers(request)
        .then(response => {
          should(kuzzle.repositories.user.scroll).be.calledWithMatch('foobar', undefined);
          should(response).be.instanceof(Object);
          should(response).match({hits: [{_id: 'admin'}], total: 2, scrollId: 'foobar'});
        });
    });

    it('should handle the scroll argument', () => {
      request = new Request({scrollId: 'foobar', scroll: 'qux'});

      kuzzle.repositories.user.scroll.resolves({
        hits: [{ _id: 'admin', _source: { profileIds: ['admin'] } }],
        total: 2,
        scrollId: 'foobar'
      });

      return securityController.scrollUsers(request)
        .then(response => {
          should(kuzzle.repositories.user.scroll).be.calledWithMatch('foobar', 'qux');
          should(response).be.instanceof(Object);
          should(response).match({hits: [{_id: 'admin'}], total: 2, scrollId: 'foobar'});
        });
    });
  });

  describe('#deleteUser', () => {
    it('should return a valid response', () => {
      kuzzle.repositories.user.delete.resolves({_id: 'test'});

      return securityController.deleteUser(new Request({ _id: 'test' }))
        .then(response => {
          should(response).be.instanceof(Object);
          should(response._id).be.exactly('test');
        });
    });

    it('should throw an error when no id is given', async () => {
      const promise = securityController.deleteUser(new Request({}));

      await should(promise).be.rejectedWith(BadRequestError, {
        id: 'api.assert.missing_argument',
        message: 'Missing argument "_id".'
      });
    });

    it('should reject an error in case of error', () => {
      const error = new Error('Mocked error');
      kuzzle.repositories.user.delete.rejects(error);

      return should(securityController.deleteUser(new Request({_id: 'test'})))
        .be.rejectedWith(error);
    });

    it('should delete user credentials', () => {
      const
        existsMethod = sinon.stub().resolves(true),
        deleteMethod = sinon.stub().resolves();
      kuzzle.pluginsManager.listStrategies.returns(['someStrategy']);
      kuzzle.repositories.user.delete.resolves({_id: 'test'});

      kuzzle.pluginsManager.getStrategyMethod
        .onFirstCall().returns(existsMethod)
        .onSecondCall().returns(deleteMethod);

      return securityController.deleteUser(new Request({ _id: 'test' }))
        .then(response => {
          should(response).be.instanceof(Object);
          should(response._id).be.exactly('test');
        });
    });

    it('should forward refresh option', () => {
      kuzzle.repositories.user.delete.resolves({_id: 'test'});

      return securityController.deleteUser(new Request({ _id: 'test', refresh: 'wait_for' }))
        .then(() => {
          const options = kuzzle.repositories.user.delete.firstCall.args[1];
          should(options).match({
            refresh: 'wait_for'
          });
        });

    });
  });

  describe('#createUser', () => {
    it('should return a valid response', () => {
      kuzzle.repositories.user.load.resolves(null);
      kuzzle.repositories.user.persist.resolves({_id: 'test'});
      kuzzle.repositories.user.hydrate.resolves();

      return securityController.createUser(new Request({
        _id: 'test',
        body: {
          content: {name: 'John Doe', profileIds: ['anonymous']}
        }
      }))
        .then(response => {
          should(kuzzle.repositories.user.persist).be.calledOnce();
          should(kuzzle.repositories.user.persist.firstCall.args[1]).match({database: {method: 'create'}});
          should(response).be.instanceof(Object);
          should(response).be.match({ _id: 'test', _source: {} });
        });
    });

    it('should compute a user id if none is provided', () => {
      kuzzle.repositories.user.load.resolves(null);
      kuzzle.repositories.user.fromDTO.callsFake((...args) => Bluebird.resolve(args[0]));
      kuzzle.repositories.user.persist.resolves({_id: 'test'});

      return securityController.createUser(new Request({
        body: {
          content: {
            name: 'John Doe',
            profileIds: ['anonymous']
          }
        }
      }))
        .then(response => {
          should(kuzzle.repositories.user.persist)
            .be.calledOnce();
          should(kuzzle.repositories.user.persist.firstCall.args[0]._id)
            .match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

          should(response).be.instanceof(Object);
          should(response).be.match({_id: 'test', _source: {} });
          should(kuzzle.repositories.user.persist.firstCall.args[1]).match({database: {method: 'create'}});
        });
    });

    it('should reject an error if user already exists', () => {
      kuzzle.repositories.user.load.resolves({_id: 'test'});

      return should(securityController.createUser(new Request({
        _id: 'test',
        body: {
          content: {name: 'John Doe', profileIds: ['anonymous']}
        }
      }))).be.rejectedWith(PreconditionError, { id: 'security.user.already_exists'});
    });

    it('should throw an error if no profile is given', () => {
      return should(() => {
        securityController.createUser(new Request({body: {content: {}}}));
      }).throw(BadRequestError, {
        id: 'api.assert.missing_argument',
        message: 'Missing argument "body.content.profileIds".'
      });
    });

    it('should throw an error if profileIds is not an array', () => {
      return should(() => {
        securityController.createUser(new Request({body: {content: {profileIds: 'notAnArray'}}}));
      }).throw(BadRequestError, {
        id: 'api.assert.invalid_type',
        message: 'Wrong type for argument "body.content.profileIds" (expected: array)'
      });
    });

    it('should forward refresh option', () => {
      kuzzle.repositories.user.load.resolves(null);
      kuzzle.repositories.user.persist.resolves({_id: 'test'});
      kuzzle.repositories.user.hydrate.resolves();

      return securityController.createUser(new Request({
        _id: 'test',
        body: {
          content: {name: 'John Doe', profileIds: ['anonymous']}
        },
        refresh: 'wait_for'
      }))
        .then(() => {
          const options = kuzzle.repositories.user.persist.firstCall.args[1];
          should(options).match({
            database: {
              refresh: 'wait_for'
            }
          });
        });
    });
  });

  describe('#persistUserAndCredentials', () => {
    beforeEach(() => {
      request = new Request({
        _id: 'test',
        body: {
          content: {name: 'John Doe', profileIds: ['anonymous']},
          credentials: {someStrategy: {some: 'credentials'}}
        }
      });
    });

    it('should reject an error if a strategy is unknown', () => {
      kuzzle.repositories.user.load.resolves(null);
      kuzzle.pluginsManager.listStrategies.returns(['someStrategy']);

      request.input.body.credentials = {unknownStrategy: {some: 'credentials'}};

      return should(securityController.createUser(request))
        .be.rejectedWith(BadRequestError, {
          id: 'security.credentials.unknown_strategy'
        });
    });

    it('should reject an error if credentials don\'t validate the strategy', () => {
      kuzzle.repositories.user.load.resolves(null);
      kuzzle.pluginsManager.listStrategies.returns(['someStrategy']);

      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'exists')
        .returns(sinon.stub().resolves(false));

      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'validate')
        .returns(sinon.stub().rejects(new Error('error')));

      return should(securityController.createUser(request))
        .be.rejectedWith(BadRequestError, { id: 'security.credentials.rejected'});
    });

    it('should reject if credentials already exist on the provided user id', () => {
      kuzzle.repositories.user.load.resolves(null);
      kuzzle.pluginsManager.listStrategies.returns(['someStrategy']);

      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'exists')
        .returns(sinon.stub().resolves(true));

      return should(securityController.createUser(request))
        .be.rejectedWith(PluginImplementationError, {
          id: 'security.credentials.database_inconsistency'
        });
    });

    it('should throw an error and rollback if credentials don\'t create properly', done => {
      const
        validateStub = sinon.stub().resolves(),
        existsStub = sinon.stub().resolves(false),
        createStub = sinon.stub().rejects(new Error('some error')),
        deleteStub = sinon.stub().resolves();

      kuzzle.repositories.user.load.resolves(null);
      kuzzle.pluginsManager.listStrategies.returns(['someStrategy']);

      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'validate')
        .returns(validateStub);
      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'exists')
        .returns(existsStub);
      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'create')
        .returns(createStub);
      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'delete')
        .returns(deleteStub);

      securityController.createUser(request)
        .then(() => done('Expected promise to fail'))
        .catch(error => {
          try {
            should(error).be.instanceof(PluginImplementationError);
            should(error.id).eql('plugin.runtime.unexpected_error');
            should(kuzzle.repositories.user.delete)
              .calledOnce()
              .calledWithMatch({_id: 'test'});

            done();
          }
          catch (e) {
            done(e);
          }
        });
    });

    it('should intercept errors during deletion of a recovery phase', done => {
      const
        validateStub = sinon.stub().resolves(),
        existsStub = sinon.stub().resolves(false),
        createStub = sinon.stub().rejects(new Error('some error')),
        deleteStub = sinon.stub().rejects(new Error('some error'));

      kuzzle.repositories.user.load.resolves(null);
      kuzzle.pluginsManager.listStrategies.returns(['someStrategy']);

      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'validate')
        .returns(validateStub);
      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'exists')
        .returns(existsStub);
      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'create')
        .returns(createStub);
      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'delete')
        .returns(deleteStub);

      securityController.createUser(request)
        .then(() => done('Expected promise to fail'))
        .catch(error => {
          try {
            should(error).be.instanceof(PluginImplementationError);
            should(error.id).eql('plugin.runtime.unexpected_error');
            should(kuzzle.repositories.user.delete)
              .calledOnce()
              .calledWithMatch({ _id: 'test' });

            done();
          }
          catch (e) {
            done(e);
          }
        });
    });

    it('should not create credentials if user creation fails', done => {
      const
        error = new Error('foobar'),
        validateStub = sinon.stub().resolves(),
        existsStub = sinon.stub().resolves(false),
        createStub = sinon.stub().resolves();

      kuzzle.repositories.user.load.resolves(null);
      kuzzle.pluginsManager.listStrategies.returns(['someStrategy']);
      kuzzle.repositories.user.persist.rejects(error);

      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'validate')
        .returns(validateStub);
      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'exists')
        .returns(existsStub);
      kuzzle.pluginsManager.getStrategyMethod
        .withArgs('someStrategy', 'create')
        .returns(createStub);

      securityController.createUser(request)
        .then(() => done('Expected promise to fail'))
        .catch(err => {
          should(err).be.eql(error);
          should(kuzzle.repositories.user.delete).not.be.called();
          should(createStub).not.be.called();
          done();
        });
    });
  });

  describe('#createRestrictedUser', () => {
    it('should return a valid response', () => {
      kuzzle.repositories.user.load.resolves(null);
      kuzzle.repositories.user.persist.resolves({_id: 'test'});
      kuzzle.repositories.user.hydrate.resolves();

      return securityController.createRestrictedUser(new Request({
        body: {content: {_id: 'test', name: 'John Doe'}}
      }), {})
        .then(response => {
          should(kuzzle.repositories.user.persist).be.calledOnce();
          should(response.userContext).be.instanceof(Object);
          should(response).be.match({_id: 'test', _source: {} });
          should(kuzzle.repositories.user.persist.firstCall.args[1]).match({database: {method: 'create'}});
        });
    });

    it('should compute a user id if none is provided', () => {
      kuzzle.repositories.user.load.resolves(null);
      kuzzle.repositories.user.persist.resolves({_id: 'test'});
      kuzzle.repositories.user.fromDTO.callsFake((...args) => Bluebird.resolve(args[0]));

      return securityController.createRestrictedUser(new Request({ body: { content: { name: 'John Doe' } } }))
        .then(response => {
          should(kuzzle.repositories.user.persist).be.calledOnce();
          should(response).be.instanceof(Object);
          should(response).be.match({_id: 'test', _source: {} });
          should(kuzzle.repositories.user.persist.firstCall.args[0]._id).match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          should(kuzzle.repositories.user.persist.firstCall.args[1]).match({database: {method: 'create'}});
        });
    });

    it('should throw an error if a profile is given', () => {
      return should(() => {
        securityController.createRestrictedUser(new Request({ body: { content: { profileIds: ['foo'] } } }));
      }).throw(BadRequestError, {
        id: 'api.assert.forbidden_argument',
        message: 'The argument "body.content.profileIds" is not allowed by this API action.'
      });
    });

    it('should forward refresh option', () => {
      kuzzle.repositories.user.load.resolves(null);
      kuzzle.repositories.user.persist.resolves({_id: 'test'});
      kuzzle.repositories.user.hydrate.resolves();

      return securityController.createRestrictedUser(new Request({
        body: {content: {_id: 'test', name: 'John Doe'}},
        refresh: 'wait_for'
      }))
        .then(() => {
          const options = kuzzle.repositories.user.persist.firstCall.args[1];
          should(options).match({
            database: {
              refresh: 'wait_for'
            }
          });
        });
    });
  });

  describe('#updateUser', () => {
    it('should return a valid response', () => {
      kuzzle.repositories.user.toDTO.returns({_id: 'test'});
      kuzzle.repositories.user.persist.resolves({_id: 'test'});

      return securityController.updateUser(new Request({ _id: 'test', body: { foo: 'bar' } }))
        .then(response => {
          should(kuzzle.repositories.user.persist).be.calledOnce();
          should(response).be.instanceof(Object);
          should(response).be.match({_id: 'test', _source: {} });
          should(kuzzle.repositories.user.persist.firstCall.args[1]).match({database: {method: 'update'}});
        });
    });

    it('should throw an error if no id is given', () => {
      return should(() => {
        securityController.updateUser(new Request({body: {}}));
      }).throw(BadRequestError, {
        id: 'api.assert.missing_argument',
        message: 'Missing argument "_id".'
      });
    });

    it('should update the profile correctly', () => {
      kuzzle.repositories.user.fromDTO.callsFake((...args) => Bluebird.resolve(args[0]));
      kuzzle.repositories.user.toDTO.returns({
        _id: 'test',
        profileIds: ['anonymous'],
        foo: 'bar',
        bar: 'baz'
      });
      kuzzle.repositories.user.persist.callsFake((...args) => Bluebird.resolve(args[0]));

      return securityController.updateUser(new Request({
        _id: 'test',
        body: {profileIds: ['anonymous'], foo: 'bar'}
      }))
        .then(response => {
          should(response).be.instanceof(Object);
          should(response._id).be.exactly('test');
          should(response._source.profile).be.an.instanceOf(Object);
          should(response._source.foo).be.exactly('bar');
          should(response._source.bar).be.exactly('baz');
        });
    });

    it('should reject the promise if the user cannot be found in the database', () => {
      kuzzle.repositories.user.load.resolves(null);
      return should(securityController.updateUser(new Request({
        _id: 'badId',
        body: {},
        action: 'updateProfile'
      }))).be.rejectedWith(NotFoundError, { id: 'security.profile.not_found'});
    });

    it('should return an error if an unknown profile is provided', () => {
      return should(() => {
        securityController.updateUser(new Request({
          _id: 'test',
          body: {profileIds: ['foobar']}
        })).throw(NotFoundError, { id: 'security.profile.not_found' });
      });
    });

    it('should forward refresh option', () => {
      kuzzle.repositories.user.fromDTO.callsFake((...args) => Bluebird.resolve(args[0]));
      kuzzle.repositories.user.toDTO.returns({});
      kuzzle.repositories.user.persist.resolves({_id: 'test'});
      kuzzle.repositories.profile.load.resolves({
        _id: 'anonymous',
        _source: {}
      });

      return securityController
        .updateUser(
          new Request({ _id: 'test', body: { foo: 'bar' }, refresh: 'wait_for' }))
        .then(() => {
          const options = kuzzle.repositories.user.persist.firstCall.args[1];
          should(options).match({
            database: {
              refresh: 'wait_for'
            }
          });
        });

    });
  });

  describe('#replaceUser', () => {
    it('should return an error if the request is invalid', () => {
      return should(securityController.replaceUser(new Request({_id: 'test'})))
        .rejectedWith(BadRequestError, { id: 'api.assert.body_required' });
    });

    it('should replace the user correctly', () => {
      kuzzle.repositories.user.persist.resolves({
        _id: 'test',
        profileIds: ['anonymous'],
        foo: 'bar'
      });
      kuzzle.repositories.user.load = userId => Bluebird.resolve({
        _id: userId,
        _source: {}
      });

      return securityController
        .replaceUser(
          new Request({
            _id: 'test',
            body: { profileIds: ['anonymous'], foo: 'bar' }
          }),
          {})
        .then(response => {
          should(response).be.instanceOf(Object);
          should(response).match({
            _id: 'test',
            _source: {profileIds: ['anonymous']}
          });
        });
    });

    it('should return an error if the user is not found', () => {
      kuzzle.repositories.user.load.resolves(null);

      return should(securityController.replaceUser(new Request({
        _id: 'i.dont.exist',
        body: { profileIds: ['anonymous'] }
      }))).be.rejectedWith(NotFoundError, { id: 'security.user.not_found'});
    });

    it('should forward refresh option', () => {
      kuzzle.repositories.user.persist.resolves({
        _id: 'test',
        profileIds: ['anonymous'],
        foo: 'bar'
      });

      kuzzle.repositories.user.load = userId => Bluebird.resolve({
        _id: userId,
        _source: {}
      });

      return securityController.replaceUser(new Request({
        _id: 'test',
        body: {profileIds: ['anonymous'], foo: 'bar'},
        refresh: 'wait_for'
      }))
        .then(() => {
          const options = kuzzle.repositories.user.persist.firstCall.args[1];

          should(options).match({
            database: {
              refresh: 'wait_for'
            }
          });
        });
    });
  });

  describe('#getUserRights', () => {
    it('should resolve to an object on a getUserRights call', () => {
      kuzzle.repositories.user.load = userId => {
        return Bluebird.resolve({
          _id: userId,
          _source: {},
          getRights: () => {
            return {
              rights1: {
                controller: 'read', action: 'get', index: 'foo', collection: 'bar',
                value: 'allowed'
              },
              rights2: {
                controller: 'write', action: 'delete', index: '*', collection: '*',
                value: 'conditional'
              }
            };
          }
        });
      };

      return securityController.getUserRights(new Request({_id: 'test'}))
        .then(response => {
          should(response).be.instanceof(Object);
          should(response.hits).be.an.Array();
          should(response.hits).length(2);

          let filteredItem = response.hits.filter(item => {
            return item.controller === 'read' &&
                    item.action === 'get' &&
                    item.index === 'foo' &&
                    item.collection === 'bar';
          });
          should(filteredItem).length(1);
          should(filteredItem[0].value).be.equal('allowed');

          filteredItem = response.hits.filter(item => {
            return item.controller === 'write' &&
                   item.action === 'delete' &&
                   item.index === '*' &&
                   item.collection === '*';
          });
          should(filteredItem).length(1);
          should(filteredItem[0].value).be.equal('conditional');
        });
    });

    it('should throw an error on a getUserRights call without id', () => {
      return should(() => {
        securityController.getUserRights(new Request({_id: ''}));
      }).throw(BadRequestError, {
        id: 'api.assert.missing_argument',
        message: 'Missing argument "_id".'
      });
    });

    it('should reject NotFoundError on a getUserRights call with a bad id', () => {
      kuzzle.repositories.user.load.resolves(null);

      return securityController.getUserRights(new Request({ _id: 'i.dont.exist' }))
        .catch((e) => {
          should(e).be.instanceOf(NotFoundError);
        });
    });
  });

  describe('#mDeleteUser', () => {
    it('should forward its args to mDelete', () => {
      securityController.mDelete = sinon.spy();
      securityController.mDeleteUsers(request);

      should(securityController.mDelete)
        .be.calledOnce()
        .be.calledWith('user', request);
    });
  });

  describe('#revokeTokens', () => {
    it('should revoke all tokens related to a given user', () => {

      return securityController.revokeTokens((new Request({ _id: 'test', })))
        .then(() => {
          should(kuzzle.repositories.token.deleteByUserId).be.calledOnce().be.calledWith('test');
        });
    });

    it('should reject an error if the user doesn\'t exists.', () => {
      kuzzle.repositories.user.load.resolves(null);
      return should(securityController.revokeTokens(new Request({
        _id: 'test'
      }))).be.rejectedWith(NotFoundError, { id: 'security.user.not_found' });
    });
  });
});
