/*
* aggregate user subject collections (called "interest") 
*/
var debug = require('debug');
var log = debug('dbj:task:interest:info');
var error = debug('dbj:task:interest:error');

var task = central.task;
var request = central.request;
var mongo = central.mongo;
var douban_key = central.conf.douban.key;

var user_ensured = require(central.cwd + '/models/user').ensured;
var utils = require('./utils');

var API_REQ_DELAY = task.API_REQ_DELAY;

// request stream
function FetchStream(arg) {
  this.ns = arg.ns;
  this.user = arg.user;
  this.perpage = arg.perpage || 100;
  this.total = 0;
  this.fetched = 0;
  this.status = 'ready';

  this.api_uri = '/v2/' + arg.ns + '/user/' + arg.user.uid + '/collections';
  return this;
}

var util = require('util');

util.inherits(FetchStream, require('events').EventEmitter);
//util.inherits(FetchStream, require('stream').Stream);

// starting to collect...
FetchStream.prototype.run = function() {
  var self = this;

  log('starting...');
  self.status = 'ing';

  // clear first
  mongo(function(db, next) {
    // remove user's all interests
    var selector;
    if (self.user.id) {
      selector = { user_id: self.user.id };
    } else {
      selector = { uid: self.user.uid };
    }
    log('cleaning old interests...');
    db.collection(self.ns + '_interest').remove(selector, function(err, r) {
      next();
      self.fetch(0, self._fetch_cb());
    });
  });
  return self;
};

// fetch page by page
FetchStream.prototype._fetch_cb = function() {
  var self = this;
  return function(err, data) {
    if (err) return self.emit('error', err);

    var total = data.total;

    // no data
    if (!total) {
      log('no data at all');
      self.status = 'succeed';
      return self.end();
    }

    if (self.total && total != self.total) {
      self.total = total;
      log('total number changed');
      // total changed during fetching, run again
      return self.run();
    };

    self.total = total;
    self.fetched += self.perpage;

    if (self.fetched >= total) {
      self.fetched = total;
      log('fetching reached end.');
      self.status = 'succeed';
      self.end();
    } else {
      self.fetch(self.fetched, self._fetch_cb());
    }
  };
};

var ERRORS = {
  '404': 'NO_USER',
};

// fetch one page of data
FetchStream.prototype.fetch = function(start, cb) {
  var self = this;

  setTimeout(function() {
    task.api(function(oauth2, next) {
      log('fetching %s~%s...', start, start + self.perpage);

      var client = oauth2.clientFromToken(self.token);
      client.request('GET', self.api_uri, { count: self.perpage, start: start }, function(err, ret, res) {
        next();

        var code = err && err.statusCode || res.statusCode;
        if (code !== 200) {
          var err_code = ERRORS[String(code)];
          self.user.invalid = err_code || 1;
          return self.emit('error', err_code || new Error('douban api responded with ' + code)); 
        }
        if (err) {
          return self.emit('error', err);
        }

        self.emit('fetched', ret);
        self.write(ret, cb);
      });
    });
  }, API_REQ_DELAY);
};

// TODO: cache data locally first, wait for some time, then commit to database
FetchStream.prototype.write = function saveInterest(data, cb) {
  var ns = this.ns
    , self = this
    , uid = self.user.uid || self.user.id
    , total = data.total
    , items = data.collections
    , subjects = [];

  if (!items.length) {
    cb && cb(null, data);
    self.emit('saved', data);
    return;
  }

  // pick up subjects
  items.forEach(function(item, i) {
    item = utils.norm_interest(item);

    item['uid'] = uid;
    item['subject_id'] = item[ns + '_id'];

    var s = item[ns];
    s = utils.norm_subject(s, ns);
    subjects.push(s);
    delete item[ns];
  });

  // `next` is to release db client lock
  mongo(function(db, next) {
    var save_options = { w: 1, continueOnError: 1 };

    // save user interest
    log('saving interests...');
    db.collection(ns + '_interest').insert(items, save_options, function(err, r) {
      if (err) {
        if (cb) cb(err);
        return next();
      }
      // save subjects
      log('saving subjects...');
      var col_s = db.collection(ns);

      //col_s.insert(subjects, { continueOnError: true }, function(err, res) {
        //log('saving complete.');
        //cb && cb(null, data);
        //next();
      //});
      function save_subject(i) {
        var s = subjects[i];
        if (!s) {
          log('all subjects in saving queue.');

          cb && cb(null, data);

          self.emit('saved', data);

          return next();
        }

        //log('updating subject %s', s.id);
        // we just don't care whether it will succeed.
        col_s.update({ 'id': s.id }, s, { upsert: true, w: -1 });
        //, function(err, r) {
          //if (err) {
            //if (cb) return cb(err);
            //return next();
          //}
        //});
        // let's save next subject
        save_subject(i + 1);
      }
      save_subject(0);
    });
  });

  self.emit('data', data);
}
FetchStream.prototype.close = FetchStream.prototype.end = function(arg) {
  this.emit('end', arg);
  this.emit('close', arg);
};
FetchStream.prototype.updateUser = function(cb) {
  var self = this;
  var ns = self.ns;
  var obj = {};
  obj[ns + '_n'] = self.total;
  obj[ns + '_synced_n'] = self.fetched;
  obj['last_synced'] = obj[ns +'_last_synced'] = new Date();
  obj['last_synced_status'] = obj[ns +'_last_synced_status'] = self.status;

  log('updating user\'s last synced status... %s: %s, status: %s',
      ns, self.total, self.status);

  // database option
  obj['$upsert'] = true;
  self.user.update(obj, cb);
};

var collect, _collect;

collect = user_ensured(function(user, arg) {
  if (!user) return arg.error && arg.error('NO_USER');

  var collector = new FetchStream(arg);

  // halt if syncing is already running
  if (user.last_synced_status === 'ing' && !arg.force) {
    error('collect interests exists for %s dur to runing', user.uid);
    arg.error && arg.error('RUNNING');
    return;
  }

  collector.on('error', function(err) {
    error('collecting for %s failed: %s', user.uid, err);
    collector.status = 'failed';
    collector.updateUser(function() {
      collector.end();
    });
  });

  collector.on('saved', function(data) {
    collector.updateUser();
  });

  collector.once('end', function() {
    // wait for the really ends
    setTimeout(function() {
      if (collector.status == 'succeed' && arg.success) {
        arg.success.call(collector, user);
      } else if (arg.error) {
        arg.error.call(collector, user);
      }
    }, 2000);
  });

  collector.run();
});

function collect_in_namespace(ns) {
  return function(arg) {
    arg.ns = ns;
    collect(arg.user, arg);
  };
}

var exports = {};

central.DOUBAN_APPS.forEach(function(item) {
  exports['collect_' + item] = collect_in_namespace(item);
});

// collect all the interest
exports.collect_all = function(user, succeed_cb, error_cb) {
  if (!user) return error_cb('NO_USER');

  var apps = central.DOUBAN_APPS;
  var collectors = [];
  (function run(i) {
    var ns = apps[i];
    // all apps proceeded
    if (!ns) succeed_cb(collectors);
    exports['collect_' + item](user, function(collectors) {
      collectors.push(collector);
      run(i+1);
    }, error_cb);
  })(0);
};
exports.collect = collect;
module.exports = exports;
