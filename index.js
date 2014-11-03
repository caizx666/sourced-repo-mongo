var Entity = require('sourced').Entity;
var EventEmitter = require('events').EventEmitter;
var log = require('debug')('sourced-repo-mongo');
var mongo = require('./mongo');
var Promise = require('bluebird');
var util = require('util');
var _ = require('lodash');

function Repository (entityType, indices) {
  EventEmitter.call(this);
  if ( ! mongo.db) {
    throw new Error('mongo has not been initialized. you must call require(\'sourced-repo-mongo/mongo\').connect(config.MONGO_URL); before instantiating a Repository');
  }
  indices = _.union(indices, ['id']);
  var self = this;
  var db = mongo.db;
  self.entityType = entityType;
  self.indices = indices;
  self.initialized = new Promise(function (resolve, reject) {
    var snapshotCollectionName = util.format('%s.snapshots', entityType.name);
    var snapshots = db.collection(snapshotCollectionName);
    self.snapshots = snapshots;
    var eventCollectionName = util.format('%s.events', entityType.name);
    var events = db.collection(eventCollectionName);
    self.events = events;
    self.indices.forEach(function (index) {
      snapshots.ensureIndex(index, reject);
      events.ensureIndex(index, reject);
    });
    log('initialized %s entity store', self.entityType.name);
    resolve();
    self.emit('ready');
  });
  log('connecting to %s entity store', this.entityType.name); 
}

util.inherits(Repository, EventEmitter);

Repository.prototype.get = function get (id, cb) {
  var self = this;
  log('getting %s for id %s', this.entityType.name, id);
  this.initialized.done(function () {
    self.snapshots
      .find({ id: id })
      .sort({ version: -1 })
      .limit(-1)
      .toArray(function (err, docs) {
        if (err) return cb(err);
        var snapshot = docs[0];
        var criteria = (snapshot) ? { id: id, version: { $gt: snapshot.version } } : { id: id };
        self.events.find(criteria)
          .sort({ version: 1 })
          .toArray(function (err, events) {
            if (err) return cb(err);
            if (snapshot) delete snapshot._id;
            return self.deserialize(id, snapshot, events, cb);
          });
    });
  });
};

Repository.prototype.commit = function commit (entity, cb) {
  var self = this;
  log('committing %s for id %s', this.entityType.name, entity.id);
  this.initialized.done(function () {
    // save snapshots before saving events
    new Promise(function (resolve, reject) {
      if (entity.version >= entity.snapshotVersion + 10) {
        var snapshot = entity.snapshot();  
        if (snapshot && snapshot._id) delete snapshot._id; // mongo will blow up if we try to insert multiple _id keys
        self.snapshots.insert(snapshot, function (err) {
          if (err) return reject(err);
          log('committed %s.snapshot for id %s %j', self.entityType.name, entity.id, snapshot);
          resolve(entity);
        });
      } else {
        resolve(entity);
      }  
    }).done(function (entity) {
      function done () {
        var eventsToEmit = entity.eventsToEmit;
        entity.eventsToEmit = [];
        eventsToEmit.forEach(function (eventToEmit) {
          var args = Array.prototype.slice.call(eventToEmit);
          self.entityType.prototype.emit.apply(entity, args);
        });
        log('emitted local events for id %s', entity.id);
        return cb();
      } 
      // when finished, save events
      if (entity.newEvents.length === 0) return done();
      var events = entity.newEvents;
      events.forEach(function (event) {
        if (event && event._id) delete event._id; // mongo will blow up if we try to insert multiple _id keys
        self.indices.forEach(function (index) {
          event[index] = entity[index];
        });
      });
      self.events.insert(events, function (err) {
        if (err) return cb(err);
        log('committed %s.events for id %s', self.entityType.name, entity.id);
        entity.newEvents = [];
        return done();
      });
    });
  });
};

Repository.prototype.deserialize = function deserialize (id, snapshot, events, cb) {
  log('deserializing %s entity ', this.entityType.name);
  var entity = new this.entityType(snapshot, events);
  entity.id = id;
  return cb(null, entity);
};

module.exports.Repository = Repository;