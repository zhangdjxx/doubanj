/*
* compute the stastics
*/
var debug = require('debug');
var log = debug('dbj:task:compute:info');
var error = debug('dbj:task:compute:error');

var cwd = process.cwd();

var consts = require(cwd + '/models/consts');
var task = require(cwd + '/lib/task');
var mongo = require(cwd + '/lib/mongo');

var user_ensured = require(cwd + '/models/user').ensured;
var Interest = require(cwd + '/models/interest').Interest;

var book_task = require('./book');

var compute, _compute;
compute = task.compute_pool.pooled(_compute = function(computings, arg, next) {
  user_ensured(function(arg) {
    var user = arg.user;

    var called = false;
    var timeouts = {};
    var clear_timeouts = function() {
      for (var j in timeouts) {
        try {
          clearTimeout(timeouts[j]);
        } catch (e) {}
      }
    }
    var error_cb = function(err) {
      err = err || 'UNKNOWN';

      clear_timeouts();

      if (!user) {
        arg.error && arg.error(err);
        if (!called) next();
        called = true;
        return;
      }
      if (err.stack) { console.log(err.stack); }

      error('compute for %s failed: %s', user.uid, err);

      if (called) return;
      called = true;

      arg.error && arg.error(err);
      if (err !== 'RUNNING') {
        var stats_fail = user.stats_fail || 0;
        // reset user's stats data if error happens
        log('resetting %s\'s compute status', user.uid);
        user.update({
          stats_fail: stats_fail + 1,
          stats_status: err,
        });
      }
      next();
    };
    var succeed_cb = function() {
      arg.success && arg.success();
    };

    if (!user) return error_cb('NO_USER');
    // already running
    if (user.stats_status == 'ing' && !arg.force) return error_cb('RUNNING');
    // not ready
    if (user.invalid) return error_cb(user.invalid);
    if (user.last_synced_status !== 'succeed') return error_cb('NOT_READY');

    var stats = user.stats || {}; // save last stats date
    var all_results = {
      stats_fail: 0,
      stats_status: 'ing',
      stats_p: 5 // start running means 5 percent of work has been done
    };
    user.update(all_results);

    var jobs_percent = {};

    function runJob(ns, done_percent) {

      var job = require('./' + ns);

      jobs_percent[ns] = 0;

      mongo.queue(function(db, next) {
        // timeout
        timeouts[ns] = setTimeout(function() {
          error_cb('TIMEOUT');
        }, 80000);

        // rung single job
        job(db, user, function(err, results) {
          if (err) {
            error_cb(err);
            return next();
          }

          // already failed, no need to save..
          if (called) return;

          clearTimeout(timeouts[ns]);

          stats[ns] = new Date();
          all_results[ns + '_stats'] = results; 

          var stats_p = all_results.stats_p;

          jobs_percent[ns] = done_percent;

          for (var j in jobs_percent) {
            stats_p += (jobs_percent[j] || 0); 
          }

          // all works done, safe to save.
          if (stats_p >= 100) {
            stats_p = 100;
            all_results.stats = stats;
            all_results.stats_p = stats_p;
            all_results.stats_status = 'succeed';

            // to ensure all the other writings are done.
            setTimeout(function() {
              user.update(all_results, function(err) {
                if (err) {
                  error_cb(err);
                } else {
                  succeed_cb(user);
                }
                next();
              });
            }, 1000);
          }
        }, function(percent) {
          if (called) return;

          // update computing percentage
          var stats_p = all_results.stats_p;
          var p = percent * done_percent / 100
          if (stats_p > p + 5) return;

          var obj = {
            stats_p: p
          };
          user.update(obj);
        });

      });
    }

    runJob('book', 95);
  })(arg);
});

module.exports = compute;
