var events = require('events');
var util = require("util");
var net = require('net-cluster');
var async = require('async');
var Buffers = require('buffers');
var _ = require('underscore');
var common = require('./common.js');
var Writable = require('stream').Writable;
var Radio = require('./radio.js');
var TypeChecker = require("./types.js");
var logger = common.logger;
var globalConf = common.globalConf;

function SocketReadAdapter(options) {
  if (!(this instanceof SocketReadAdapter))
    return new SocketReadAdapter(options);

  Writable.call(this, options);

  this._buf = new Buffers();
  this._dataSize = 0;
}

util.inherits(SocketReadAdapter, Writable);

function protocolPack(data) {
  var len = data.length;
  var c1, c2, c3, c4;
  var tmp = new Buffer(4);
  c1 = len & 0xFF;
  len >>= 8;
  c2 = len & 0xFF;
  len >>= 8;
  c3 = len & 0xFF;
  len >>= 8;
  c4 = len & 0xFF;
  tmp[0] = c4;
  tmp[1] = c3;
  tmp[2] = c2;
  tmp[3] = c1;
  var packed = Buffer.concat([tmp, data], 4+data.length);
  tmp = null;
  data = null;
  return packed;
};


function bufferToPack(data, header, fn) {
  async.waterfall([
    // compress data
    function(callback){
      if (header['compress']) {
        common.qCompress(data, function(d) {
          callback(null, d);
        });
      }else{
        callback(null, data);
      }
    },
    // add header
    function(d_data, callback){
      var tmpData = new Buffer(1);
      tmpData[0] = (header['compress'] & 0x1) | ((header['pack_type'] & SocketClient.PACK_TYPE['MASK']) << 0x1);
      d_data = Buffer.concat([tmpData, d_data]);
      callback(null, d_data);
    }
  ], function(err, result){
    if (err) {
      logger.error(err);
    }else{
      fn(result);
    }
  });
}

SocketReadAdapter.prototype._write = function(chunk, encoding, done) {
  var adapter = this;
  adapter._buf.push(chunk);
  
  function GETPACKAGESIZEFROMDATA() {
    var pg_size_array = adapter._buf.splice(0, 4);
    pg_size_array = pg_size_array.toBuffer();
    var pg_size = (pg_size_array[0] << 24) 
                + (pg_size_array[1] << 16) 
                + (pg_size_array[2] << 8) 
                + pg_size_array[3];
    pg_size_array = null;
    return pg_size;
  }
  
  function READRAWBYTES(size) {
    var data = adapter._buf.splice(0, size);
    data = data.toBuffer();
    return data;
  }
  
  function REBUILD(rawData) {
    return protocolPack(rawData);
  }
  
  function GETFLAG(pkgData) {
    return {
      'compress': pkgData[0] & 0x1,
      'pack_type': (pkgData[0] >> 0x1) & SocketClient.PACK_TYPE['MASK']
    };
  }
  
  var loop_time_ = 0;
  // should be while(true), but in case we have some quirk conditions causing dead loop
  while (loop_time_ < 255) {
    if(adapter._dataSize === 0){
      if (adapter._buf.length < 4){
        done();
        return;
      }
      adapter._dataSize = GETPACKAGESIZEFROMDATA();
    }
    if (adapter._buf.length < adapter._dataSize){
      done();
      return;
    }


    var packageData = READRAWBYTES(adapter._dataSize); // raw single package
    var p_header = GETFLAG(packageData);  // 8bits header
    var dataBlock = packageData.slice(1); // dataBlock has no header
    var repacked = REBUILD(packageData);  // repacked, should be equal with packageData

    var afterUncompress = function(d, err) {
      if(err){
        logger.error('Uncompress error:', err);
        return;
      }
      adapter.emit('message', this.p_header['pack_type'], d, this.repacked);
    };
    afterUncompress = afterUncompress.bind({
      'repacked': repacked,
      'p_header': p_header
    });

    if(p_header['compress']) {
      common.qUncompress(dataBlock, afterUncompress);
    }else{
      adapter.emit('message', p_header['pack_type'], dataBlock, repacked);
    }
    adapter._dataSize = 0;
    loop_time_++;
  }
  done();
};

SocketReadAdapter.prototype.cleanup = function() {
  this._buf = null;
  this._dataSize = 0;
  this.removeAllListeners();
};

var SocketClientDefines = {};

SocketClientDefines.PACK_TYPE = {
  'MANAGER': 0x0,
  'COMMAND': 0x1,
  'DATA': 0x2,
  'MESSAGE': 0x3,
  'MASK': 0x3 // sepcial one, not really one of types but just a bit mask
};

SocketClientDefines.CLIENT_STATUS = {
  'INIT': 0,
  'RUNNING': 1,
  'CLOSED': 2,
  'DESTROYED': 3
};

function SocketClient(socket) {
  events.EventEmitter.call(this);

  var client = this;
  client['socket'] = socket;
  client['anonymous_login'] = false;
  client['adapter'] = null;
  client['status'] = SocketClient.CLIENT_STATUS['INIT'];
  client['clientid'] = null;
  client['username'] = null;
  try {
    client['ip'] = socket.remoteAddress;
  } catch(err) {
    //
  }

  client.socket.on('close', function(){
    // no more output
    if (client.socket) {
      client.socket.unpipe();
    }

    // time to destroy associated stream
    if (client['adapter']) {
      client['adapter'].cleanup();
      client['adapter'] = null;
    }
    if (client.socket) {
      client.socket.removeAllListeners('message');
      client.socket.removeAllListeners('drain');
    }
    
    process.nextTick(function(){
      client.emit('close');
    });
  });

  client.adapter = new SocketReadAdapter();
  client.socket.pipe(client.adapter);

  client.adapter.on('message', function(pack_type, data, rawData){
    var PT = SocketClient.PACK_TYPE;
    switch(pack_type){
      case PT['MANAGER']:
      client.emit('manager', data);
      break;
      case PT['COMMAND']:
      client.emit('command', data);
      break;
      case PT['DATA']:
      client.emit('data', rawData);
      break;
      case PT['MESSAGE']:
      client.emit('message', rawData);
      break;
      default:
      // just do nothing
      logger.warn('unknown pack type', pack_type);
      break;
    }
  });
}

util.inherits(SocketClient, events.EventEmitter);

_.extend(SocketClient, SocketClientDefines);

SocketClient.prototype.writeRaw = function(data, fn) {
  try {
    this.socket.write(data, fn);
  }catch(err){
    // give it a chance to run callback
    if (TypeChecker.isFunction(fn)) {
      fn();
    }
  }
}

SocketClient.prototype.sendPack = function(data, fn) {
  this.writeRaw(protocolPack(data), fn);
}

SocketClient.prototype.sendDataPack = function(data, fn) {
  var socket_client = this;
  bufferToPack(
    data, 
    {
      'compress': true, 
      'pack_type': SocketClient.PACK_TYPE['DATA']
    }, function(result){
      socket_client.sendPack(result, fn);
  });
}

SocketClient.prototype.sendMessagePack = function(data, fn) {
  var socket_client = this;
  bufferToPack(
    data, 
    {
      'compress': true, 
      'pack_type': SocketClient.PACK_TYPE['MESSAGE']
    }, function(result){
      socket_client.sendPack(result, fn);
  });
}

SocketClient.prototype.sendCommandPack = function(data, fn) {
  var socket_client = this;
  bufferToPack(
    data, 
    {
      'compress': true, 
      'pack_type': SocketClient.PACK_TYPE['COMMAND']
    }, function(result){
      socket_client.sendPack(result, fn);
  });
}

SocketClient.prototype.sendManagerPack = function(data, fn) {
  var socket_client = this;
  bufferToPack(
    data, 
    {
      'compress': true, 
      'pack_type': SocketClient.PACK_TYPE['MANAGER']
    }, function(result){
      socket_client.sendPack(result, fn);
  });
}

SocketClient.prototype.close = function() {
  var self = this;
  try {
    self.socket.end();
    self.status = SocketClient.CLIENT_STATUS['CLOSED'];
    process.nextTick(function(){
      self.emit('close');
    });
  }catch(err){
    logger.error(err);
  }
}

SocketClient.prototype.kill = function() {
  var self = this;
  try {
    self.socket.destroy();
    self.status = SocketClient.CLIENT_STATUS['CLOSED'];
    process.nextTick(function(){
      self.emit('close');
    });
  }catch(err){
    logger.error(err);
  }
}

SocketClient.prototype.destroy = function() {
  this.socket = null;
  this.anonymous_login = false;
  this.adapter = null;
  this.status = SocketClient.CLIENT_STATUS['DESTROYED'];
  var self = this;
  process.nextTick(function(){
    self.removeAllListeners();
  });
}



function SocketServer(options) {
  net.Server.call(this);
  
  var defaultOptions = {
    archive: 'tmp.tmp',
    archiveSign: '',
    recovery: false,
    record: true,
    keepAlive: true
  };
  
  if(TypeChecker.isUndefined(options)) {
    var options = {};
  }
  var op = _.defaults(options, defaultOptions);
  
  var server = this;
  server.options = op;
  server.clients = [];
  server.nullDevice = common.nullDevice;
  server.radio = null;

  if (op.record) {
    server.radio = new Radio({
      'filename': server.options['archive'], 
      'signature': server.options['archiveSign'],
      'recovery': server.options['recovery']
    });
    server.radio.once('ready', function(){
      server.options['archiveSign'] = server.radio['versionSignature'];
      process.nextTick(function(){
        server.emit('ready');
      });
    });
  }else{
    process.nextTick(function(){
      server.emit('ready');
    });
  }

  server.unalive = false; // indicates server is still alive

  server.on('connection', function(cli) {
    cli.setKeepAlive(server.options.keepAlive);
    cli.setNoDelay(true);
    var socket_client = new SocketClient(cli);
    server.clients.push(socket_client);

    var onclose = function () {
      // erase from client list
      var index = server.clients.indexOf(socket_client);
      server.clients.splice(index, 1);
      socket_client.destroy();
    };

    var onerror = function (err) {
      logger.error('Error with socket:', err);
    };

    cli.on('error', onerror);

    socket_client.on('manager', function(data){
      server.emit('clientmanager', data);
    }).on('command', function(data){
      server.emit('clientcommand', data);
    }).on('data', function(rawData){
      server.emit('clientdata', rawData);
      server.radio.write(rawData);
    }).on('message', function(rawData){
      server.emit('clientmessage', rawData);
      server.radio.send(rawData);
    }).once('close', onclose);

    process.nextTick(function(){
      server.emit('newclient', socket_client);
    });

  }).on('error', function(err) {
    logger.error('Error with socket:', err);
  });
}

util.inherits(SocketServer, net.Server);

SocketServer.prototype.sendDataTo = function (client_ref, data, pack_type) {
  var self = this;
  if(self.unalive) {
    return;
  }
  bufferToPack(data, {'compress': true, 'pack_type': pack_type}, function(result) {
    if ( self.radio.isClientInRadio(client_ref) ) {
      var datapack = protocolPack(result);
      self.radio.singleSend(datapack, client_ref);
    }else{
      client_ref.sendPack(result);
    }
  });
};

SocketServer.prototype.broadcastData = function (data, pack_type) {
  var server = this;
  if(server.unalive) {
    return;
  }
  // TODO: need to change for new interface of SocketClient
  var PT = SocketClient.PACK_TYPE;
  bufferToPack(data, {'compress': true, 'pack_type': pack_type}, function(result) {
    var datapack = protocolPack(result);
    server.radio.send(datapack);
  });
};

SocketServer.prototype.kick = function(client_ref) {
  if(this.unalive) {
    return;
  }
  client_ref.close();
};

SocketServer.prototype.pruneArchive = function() {
  var self = this;
  if(self.unalive) {
    return;
  }
  if (self.radio) {
    self.radio.prune();
    self.radio.once('pruned', function(){
      self.emit('archivecleared', self.radio.versionSignature);
    });
  }
};

SocketServer.prototype.archiveLength = function() {
  var self = this;
  if (self.radio) {
    return self.radio.dataLength();
  }else{
    return 0;
  }
};

SocketServer.prototype.joinRadio = function(cli, start, end) {
  this.radio.addClient(cli, start, end);
};

SocketServer.prototype.closeServer = function(delete_archive) {
  var self = this;
  if (self.radio) {
    if (delete_archive) {
      self.radio.removeFile();
    }
    self.radio.cleanup();
    self.radio = null;
  }
  self.unalive = true;
  self.close();
};

exports.SocketServer = SocketServer;
exports.SocketClient = SocketClient;
exports.SocketReadAdapter = SocketReadAdapter;
exports.util = {
  'protocolPack': protocolPack,
  'bufferToPack': bufferToPack
};
