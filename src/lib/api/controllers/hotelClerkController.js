var
  _ = require('lodash'),
  async = require('async'),
  q = require('q'),
  // module for manage md5 hash
  crypto = require('crypto');


module.exports = function HotelClerkController (kuzzle) {

  this.kuzzle = kuzzle;
  /**
   * A simple room list with filter associate and how many users have subscribed
   *
   * Example for subscribe to a chat room where the subject is Kuzzle
   *  rooms = {
   *    'f45de4d8ef4f3ze4ffzer85d4fgkzm41' : { // -> the room id (according to filters and collection)
   *      names: [ 'chat-room-kuzzle' ], // -> real room name list to notify
   *      count: 100 // -> how many users have subscribed to this room
   *      filters: [ message.subject.termSubjectKuzzle ] // -> filters needed to send message to this room
   *    }
   *  }
   */
  this.rooms = {};
  /**
   * In addition to this.rooms, this.customers allow to manage users and their rooms
   * Example for a customer who subscribes to the room 'chat-room-kuzzle'
   * customers = {
   *  '87fd-gre7ggth544z' : { // -> connection id (like socket id)
   *    'chat-room-kuzzle' : 'fr4fref4f8fre47fe' // -> mapping between user room and roomId
   *  }
   * }
   */
  this.customers = {};
  /**
   *
   * A tree where we have an entry by collection, an entry by tag and
   * an entry by filter (curried function) with the rooms list
   *
   * Example for chat-room-kuzzle (see above)
   *  filtersTree = {
   *    message : { // -> collection name
   *      subject : { // -> attribute where a filter exists
   *        termSubjectKuzzle : {
   *          rooms: [ 'f45de4d8ef4f3ze4ffzer85d4fgkzm41'], // -> room id that match this filter
   *          fn: function () {} // -> function to execute on collection message, on field subject
   *        }
   *      }
   *    }
   *  }
   */
  this.filtersTree = {};


  // BIND PRIVATE METHODS
  var tools = {};
  tools.addRoomForCustomer = _.bind(addRoomForCustomer, this);
  tools.removeRoomForCustomer = _.bind(removeRoomForCustomer, this);
  tools.createRoom = _.bind(createRoom, this);
  tools.cleanUpRooms = _.bind(cleanUpRooms, this);

  /**
   * Add a connectionId to room, and init information a
   * bout room if it doesn't exist before
   *
   * @param {String} connectionId
   * @param {String} roomName
   * @param {String} collection
   * @param {Object} filters
   * @return {Promise} promise. Return nothing on success. Reject with error if the
   * user has already subscribe to this room name (just for room with same name, but we not trigger error
   * if the room has a different name with same filter) or if there is an error during room creation
   */
  this.addSubscription = function (connectionId, roomName, collection, filters) {
    var
      deferred = q.defer();

    if (this.customers[connectionId] && this.customers[connectionId][roomName]) {
      deferred.reject('User already subscribe to the room '+roomName);
      return deferred.promise;
    }

    tools.createRoom(roomName, collection, filters)
      .then(function (roomId) {
        // Add the room for the customer
        tools.addRoomForCustomer(connectionId, roomName, roomId);
        this.rooms[roomId].count++;

        console.log(this.filtersTree);
        console.log(this.rooms);

        deferred.resolve();
      }.bind(this))
      .catch(function (error) {
        deferred.reject(error);
      });

    return deferred.promise;
  };

  /**
   * Remove the connectionId from the room and clean up room (delete room if there is no customer)
   *
   * @param {String} connectionId
   * @param {String} room
   * @returns {Promise} promise
   */
  this.removeSubscription = function (connectionId, room) {
    var deferred = q.defer();

    // Remove the room for the customer, don't wait for delete before continue
    tools.removeRoomForCustomer(connectionId, room)
      .then(function (roomId) {
        if (!this.rooms[roomId]) {
          deferred.reject('Room ' + room + ' with id ' + roomId + ' doesn\'t exist');
        }

        this.rooms[roomId].count--;
        tools.cleanUpRooms(roomId);

        deferred.resolve();
      }.bind(this))
      .catch( function (error) {
        deferred.reject(error);
      });

    return deferred.promise;
  };

  /**
   * This function will delete customer from this.customers and
   * decrement count in this.rooms for rooms where user has subscribed
   * Call the cleanUpRooms function for manage empty room
   * Typically called on user disconnection
   *
   * @param {String} connectionId can be a socket.id
   */
  this.removeCustomerFromAllRooms = function (connectionId) {
    if (!this.customers[connectionId]) {
      return false;
    }

    var rooms = this.customers[connectionId];
    async.each(Object.keys(rooms), function (roomName) {
      var roomId = rooms[roomName];
      if (!this.rooms[roomId]) {
        return false;
      }

      this.rooms[roomId].count--;
      tools.cleanUpRooms(roomId);
    }.bind(this));

    delete this.customers[connectionId];
  };

  /**
   * Allow to retrieve the real room names (the one registered by the user) according to
   * the id (= filter and collection md5 hash)
   *
   * @param {Array} roomsIds
   * @returns {Promise} promise
   */
  this.findRoomNamesFromIds = function (roomsIds) {
    var
      deferred = q.defer(),
      roomNames = [];

    async.each(roomsIds, function (roomsId, callback) {
      if (!this.rooms[roomsId]) {
        callback();
        return false;
      }

      roomNames = roomNames.concat(this.rooms[roomsId].names);
      callback();
    }.bind(this), function () {
      deferred.resolve(roomNames);
    });

    return deferred.promise;
  };
};



/** MANAGE ROOMS **/

/**
 * Create new room if needed
 *
 * @param {String} room
 * @param {String} collection
 * @param {Object} filters
 * @returns {Promise} promise
 */
createRoom = function (room, collection, filters) {
  var
    tools = {},
    deferred = q.defer(),
    stringifyObject = JSON.stringify({collection: collection, filters: filters}),
    roomId = crypto.createHash('md5').update(stringifyObject).digest('hex');

  if (!this.rooms[roomId]) {
    // If it's a new room, we have to calculate filters to apply on the future documents
    tools.addRoomAndFilters = _.bind(addRoomAndFilters, this);
    tools.addRoomAndFilters(roomId, collection, filters)
      .then(function (formattedFilters) {

        if (!this.rooms[roomId]) {
          this.rooms[roomId] = {
            names: [],
            count: 0,
            filters: formattedFilters
          };
        }

        console.log(this.rooms);
        console.log(this.filtersTree);
        deferred.resolve(roomId);
      }.bind(this))
      .catch(function (error) {
        deferred.reject(error);
      });
  }
  else {
    deferred.resolve(roomId);
  }

  return deferred.promise;
};

/**
 * Associate the room to the connectionId in this.clients
 * Allow to manage later disconnection and delete socket/rooms/...
 *
 * @param {String} connectionId
 * @param {String} roomName
 * @param {String} roomId
 */
addRoomForCustomer = function (connectionId, roomName, roomId) {
  if (!this.customers[connectionId]) {
    this.customers[connectionId] = {};
  }

  this.rooms[roomId].names = _.uniq(this.rooms[roomId].names.concat([roomName]));
  this.customers[connectionId][roomName] = roomId;
};

/**
 * Delete room if no use has subscribed to this room and remove also the room in
 * filterTree object
 *
 * @param {String} roomId
 */
cleanUpRooms = function (roomId) {
  var tools = {};
  tools.removeRoomFromFilterTree = _.bind(removeRoomFromFilterTree, this);

  if (!this.rooms[roomId]) {
    return false;
  }
  if (this.rooms[roomId].count === 0) {
    tools.removeRoomFromFilterTree(roomId);
    delete this.rooms[roomId];
  }
};


/** MANAGE CUSTOMERS **/

/**
 * Remove the room from subscribed room from the user
 * Return the roomId in user mapping
 *
 * @param {String} connectionId
 * @param {String} roomName
 * @return {Promise} promise
 */
removeRoomForCustomer = function (connectionId, roomName) {
  var
    deferred = q.defer(),
    tools = {},
    roomId;

  tools.cleanUpCustomers = _.bind(cleanUpCustomers, this);

  if (!this.customers[connectionId]) {
    deferred.reject('The user with connection ' + connectionId + ' doesn\'t exist');
    return deferred.promise;
  }

  if (!this.customers[connectionId][roomName]) {
    deferred.reject('The user with connectionId ' + connectionId + ' doesn\'t listen the room ' + roomName);
    return deferred.promise;
  }

  roomId = this.customers[connectionId][roomName];
  deferred.resolve(roomId);

  delete this.customers[connectionId][roomName];
  tools.cleanUpCustomers(connectionId);

  return deferred.promise;
};

/**
 * Remove the user if he didn't has subscribed to a room
 *
 * @param {String} connectionId
 */
cleanUpCustomers = function (connectionId) {
  if (_.isEmpty(this.customers[connectionId])) {
    delete this.customers[connectionId];
  }
};


/** MANAGE FILTERS TREE **/

/**
 * Create curried filters function and add collection/field/filters/room to the filtersTree object
 *
 * Transform something like:
 * {
 *  term: { 'subject': 'kuzzle' }
 * }
 *
 * Into something like:
 * {
 *  subject: { 'termSubjectKuzzle' : { fn: function () {}, rooms: [] } },
 * }
 * And inject it in the right place in filtersTree according to the collection and field
 *
 * @param {String} roomId
 * @param {String} collection
 * @param {Object} filters
 * @return {Promise} promise. Resolve a list of path that points to filtersTree object
 */
addRoomAndFilters = function (roomId, collection, filters) {
  return this.kuzzle.dsl.addCurriedFunction(this.filtersTree, roomId, collection, filters)
};

/**
 * Delete the room from filterTree
 * If the room was the only room for the filter, we have to delete the filter
 * If the filter was the only filter for the field, we have to remove the field
 * If the field was the only field of the collection, we have to remove the collection

 * @param {String} roomId
 */
removeRoomFromFilterTree = function (roomId) {
  var deferred = q.defer();

  if (!this.rooms[roomId]) {
    deferred.reject();
    return deferred.promise;
  }

  var tools = {};
  tools.recursiveCleanUpTree = _.bind(recursiveCleanUpTree, this);

  var filters = this.rooms[roomId].filters;

  async.each(filters, function (filterPath, callback) {
    tools.recursiveCleanUpTree(this.filtersTree, filterPath, roomId);
    callback();

  }.bind(this), function () {
    deferred.resolve();
  });

  return deferred.promise;
};

/**
 * Recursively test filtersTree object according to the path.
 * Delete entry if it's empty and reach back in the object
 *
 * @param {Object} object
 * @param {String} path
 * @param {String} roomId
 */
recursiveCleanUpTree = function (object, path, roomId) {
  var
    parent = object,
    subPath,
    index,
    i = 0;

  path = path.split('.');

  // Loop inside the object for find the right entry
  for (i = 0; i < path.length-1; i++) {
    parent = parent[path[i]];
  }

  subPath = path[path.length-1];

  // If the current entry is the curried function (that contains the room list and the function definition)
  if (parent[subPath].rooms !== undefined) {
    index = parent[subPath].rooms.indexOf(roomId);
    if (index > -1) {
      parent[subPath].rooms.slice(index, 1);
    }

    if (parent[subPath].rooms.length > 1) {
      return false;
    }
  }
  // If it's not a function, test if the entry is not empty
  else if (!_.isEmpty(parent[subPath])) {
    return false;
  }

  delete parent[subPath];

  path.pop();
  if (_.isEmpty(path)) {
    return false;
  }

  return recursiveCleanUpTree(object, path.join('.'));
};