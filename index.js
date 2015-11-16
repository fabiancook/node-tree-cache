/**
 Copyright 2015 Fabian Cook

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

var UUID         = require('node-uuid'),
    Util         = require('util'),
    Q            = require('q'),
    EventEmitter = require('events');

function Node(id){
  EventEmitter.call(this);
  this.parent = null;
  this.nodes = [];
  this.id = id || UUID.v4( );
}

Util.inherits(Node,EventEmitter);

Node.prototype.getParent = function(){
  return this.parent;
};

Node.prototype.setParent = function(parent){
  this.parent = parent;
};

Node.prototype.isRoot = function(){
  return !this.parent;
};

Node.prototype.appendChild = function(node) {
  node.setParent(this);
  this.nodes.push(node);
  this.emit('added', node);
};

Node.prototype.removeChild = function(node) {
  var index = this.nodes.indexOf(node);
  if(index === -1){
    return index;
  }
  this.nodes.splice(index, 1);
  this.emit('removed', node);
};

Node.prototype.find = function(id) {
  var node = undefined;

  this.walk(function(walkedNode){
    if(walkedNode.id !== id){
      return true;
    }
    node = walkedNode;
    return false;
  });

  return node;
};

Node.prototype.walk = function(handler) {
  var nodes = this.nodes.slice(),
      node,
      shouldContinue,
      layers = [],
      layer;
  // The first layer is more important to walk first,
  // because the node we are looking for is more likely
  // to be in a top layer, once the top layer has been walked
  // we just need to walk through the next layers in what
  // ever order
  while(node = nodes.shift()) {
    shouldContinue = handler(node);
    if (shouldContinue === false) {
      return true;
    }
    layers.push(node.nodes);
  }
  while(layer = layers.shift()){
    while(node = layer.shift()){
      shouldContinue = !node.walk(handler);
      if(shouldContinue === false){
        return true;
      }
    }
  }
  return false;
};

function CacheDriver(cache, options) {
  this.cache = cache;
  this.options = options || {};
}

CacheDriver.prototype.get = function(key){
  var that = this,
      deferred;
  deferred = Q.defer();
  this.cache.get(key, deferred.makeNodeResolver());
  return deferred.promise
    .then(function(value){
      if(value !== null){
        return value;
      }
      throw new Error('Not Found');
    })
    .then(function(value){
      if(that.options['stringify']) {
        value = JSON.parse(value)
      }
      return value;
    })
};

CacheDriver.prototype.set = function(key, value){
  var deferred;
  if(this.options['stringify']) {
    value = JSON.stringify(value);
  }
  deferred = Q.defer();
  this.cache.set(key, value, deferred.makeNodeResolver());
  return deferred.promise
};

function SimpleCache(){
  this._values = {};
}

SimpleCache.prototype.get = function(key, callback){
  var value = this._values[key];
  setTimeout(callback.bind(null, value), 0);
};

SimpleCache.prototype.set = function(key, value, callback){
  this._values[key] = value;
  setTimeout(callback.bind(null, null));
};


CacheNode.create = function(id, options){
  options = options || {};
  options['cache'] = exports.getCache(options);

  return options['cache'].get('tc:root:' + id)
    .then(function(map){
      // Children in the map will be direct children of this node
      return CacheNode.createFromMap(id, map, options['cache'], options);
    })
    .catch(function(error){
      var construct;
      if(error['message'] !== 'Not Found'){
        throw error;
      }
      construct = options[ 'nodeConstructor' ] || CacheNode;
      return new construct(id, options['cache'], options);
    });
};

CacheNode.createFromMap = function(id, map, cache, options){
  var node,
    childMap,
    child,
    childId,
    children,
    construct;
  construct = options[ 'nodeConstructor' ] || CacheNode;
  node = new construct(id, cache, options);
  while(childMap = map.shift()) {
    childId = childMap[0];
    children = childMap[1];
    child = CacheNode.createFromMap(childId, children, cache, options);
    node.appendChild(child);
  }
  return node;
};

CacheNode.getCache = function(options){
  var cache = options.cache;
  if(cache instanceof CacheDriver){
    return cache;
  }
  if(!cache || !(cache.set && cache.get)){
    cache = new SimpleCache();
  }
  return new CacheDriver(cache, options);
};

function CacheNode(id, cache, options){
  Node.call(this, id);
  this.cache = cache;
  this.options = options || {};

  this.setUpListeners( );
}

Util.inherits(CacheNode, Node);

CacheNode.prototype.setUpListeners = function(){
  if(this.parent){
    return;
  }
  // Push this up the event chain
  this.on('invalidated', this.parent.emit.bind(this.parent, 'invalidated'));
  this.on('changed', this.parent.emit.bind(this.parent, 'updated'));
};

CacheNode.prototype.createMap = function(){
  var map = [],
      nodes = this.nodes.slice(),
      node,
      childMap;
  while(node = nodes.shift()){
    childMap = [];
    childMap.push(node.id);
    childMap.push(node.createMap());
    map.push(childMap);
  }
  return map;
};

CacheNode.delete = function(){
  return this.set(null)
    .then(this.parent.removeChild.bind(this.parent, this))
};

CacheNode.set = function(value){
  var that = this;
  this._temp_value = value;
  this._temp_value_null = value === null;
  return this.cache.set('tc:node:' + this.id, value)
    .then(function(){
      that.emit('changed', value);
    })
    .then(function(){
      return value
    })
    .finally(function(){
      that._temp_value = null;
      that._temp_value_null = null;
    });
};

CacheNode.get = function(){
  if(this._temp_value_null){
    return Q.reject(new Error('Not Found'))
  }
  if(this._temp_value !== null) {
    return Q(this._temp_value);
  }
  return this.cache.get('tc:node:' + this.id);
};

CacheNode.invalidate = function(){
  var promise;
  if(!(this.options['reviver'] instanceof Function)){
    // If no reviver then clear the value
    return this.set(null);
  }
  try {
    promise = this.options['reviver'](this);
  }catch(error){
    promise = Q.reject(error);
  }
  if(!Q.isPromise(promise)){
    return this.get();
  }
  return promise
    .then(this.set.bind(this))
    // If the reviver fails then kill it
    .catch(this.set.bind(this, null))
};

exports = module.exports = CacheNode;

exports.Node = Node;
exports.CacheDriver = CacheDriver;
exports.SimpleCache = SimpleCache;
exports.CacheNode = CacheNode;