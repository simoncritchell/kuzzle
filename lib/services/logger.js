var
  rp = require('request-promise'),
  _ = require('lodash'),
  util = require('util');


module.exports = logger =  {


  /**
   * @param kuzzle
   */
  init: function () {
  },

  /**
   * return the process Data about Kuzzle
   */
  getProcessData: function(){
      var processData = {
      pid : process.pid,
      memory: util.inspect(process.memoryUsage())
    };

    //undefined in non POSIX OS
    if(process.getgid){
      processData.gid = process.getgid();
    }
    return processData;
  },



  /**
   * send data from log with kuzzle state
   * @param object a RequestObject,  or relevant info for event
   * @param hookEvent hook from log  (exemple : "data:delete")
   * @param metaData (optional) metaData (for kuzzle, the nbRooms, the nbCustomers,...)
   */
  log: function (object, hookEvent, metaData) {

    var log = {
      hookEvent : hookEvent,
      processData : this.getProcessData(),
      timestamp : Date.now(),
      object  : object,
      metaData : metaData
    };

    log.object = object;

    rp({
      url: 'http://' + process.env.LOG_ENGINE_HOST,
      method: 'GET',
      json: {message : log }
    });
  },

  error: function (error, hookEvent, metaData) {
    var log = {
      hookEvent : hookEvent,
      timestamp : Date.now(),
      processData : this.getProcessData(),
      metaData : metaData
    };

    if (util.isError(error)) {
      log.object = { message: error.message, stack: error.stack };
    }
    else {
      log.object = error;
    }

    rp({
      url: 'http://' + process.env.LOG_ENGINE_HOST,
      method: 'GET',
      json: {message : log }
    });
  }


};