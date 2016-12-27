//
//  LogicalBridge.js
//  Homematic Virtual Interface Core
//
//  Created by Thomas Kluge on 30.11.16.
//  Copyright � 2016 kSquare.de. All rights reserved.
//
//  Scriptengine adapted from https://github.com/hobbyquaker/mqtt-scripts/

"use strict";

var xmlrpc = require(__dirname + "/../../lib/homematic-xmlrpc");

var modules = {
    'fs': require('fs'),
    'path': require('path'),
    'vm': require('vm'),
    'domain': require('domain'),
    'node-schedule': require('node-schedule'),
    'suncalc': require('suncalc'),
    'url': require('url'),
    'promise':require('promise'),
    'http' : require("http"),
    'moment':require("moment")

};

var domain = modules.domain;
var vm = modules.vm;
var fs = modules.fs;
var path = modules.path;
var scheduler = modules['node-schedule'];
var suncalc = modules.suncalc;
var url = modules.url;
var http = modules.http;
var Promise = modules.promise;
var moment = modules.moment;

var _global = {};

var LogicalBridge = function(plugin,name,server,log) {
	this.plugin = plugin;
	this.server = server;
	this.log = log;
	this.name = name;
	this.interface = "BidCos-RF";
	this.scripts = {};
    this.subscriptions = [];
	this.sunEvents = [];
	this.sunTimes = [/* yesterday */ {}, /* today */ {}, /* tomorrow */ {}];
	this.cache = {};
}


LogicalBridge.prototype.init = function() {
	var that = this;
	this.configuration = this.server.configuration;
    this.hm_layer = this.server.getBridge();
	this.log.info("Init %s",this.name);
	var port = this.configuration.getValueForPluginWithDefault(this.name,"bridge_port",7002);
	var localIP = this.hm_layer.getIPAddress();
	
	
	this.server = xmlrpc.createServer({
      host: localIP,
      port: port
    });

    
    this.methods = {
   	'system.listMethods': function listMethods(err, params, callback) {
	   	    that.log.debug('rpc < system.listMethods', null, params);
            that.log.debug('repl  >', null, JSON.stringify(Object.keys(that.methods)));
            callback(null,Object.keys(that.methods));
    },
    
    'listDevices': function listDevices(err, params, callback) {
      that.log.debug('rpc <- listDevices Zero Reply');
      callback(null,[]);
    },


    'newDevices': function newDevices(err, params, callback) {
      that.log.debug('rpc <- newDevices Zero Reply');
      callback(null,[]);
    },
   
   
    'event': function event(err, params, callback) {
      that.log.debug('rpc <- event Zero Reply');
      callback(null,[]);
    },
    
    'system.multicall': function systemmulticall(err, params, callback) {
      that.log.debug('rpc <- system.multicall Zero Reply');
      
      
      params.map(function(events) {
        try {
          events.map(function(event) {
            if ((event["methodName"] == "event") && (event["params"] !== undefined)) {
              var params = event["params"];
              var channel = that.interface + "." + params[1];
              var datapoint = params[2];
              var value = params[3];
          	  that.log.debug("RPC event for %s %s with value %s",channel,datapoint,value);
          	  that.doCache(channel,datapoint,value);
          	  that.ccuEvent(channel,datapoint,value);
          	  
            }
          });
        } catch (err) {}
      });
      callback(null,[]);
    } 
	
	};
    
    
    Object.keys(that.methods).forEach(function (m) {
           that.server.on(m, that.methods[m]);
    });
    
    // Publish Server to CCU
    var ccuIP =  this.hm_layer.ccuIP;
    
    this.client = xmlrpc.createClient({
      host: ccuIP,
      port: 2001,
      path: "/"
    });
    
    this.log.debug("CCU RPC Init Call for interface %s",this.interface);
    this.client.methodCall("init", ["http://" + localIP + ":" + port , "hvl_BidCos" ], function(error, value) {
      that.log.debug("CCU Response ...Value (%s) Error : (%s)",JSON.stringify(value) , error);
    });

	this.calculateSunTimes();
	this.reInitScripts();
}


LogicalBridge.prototype.regaCommand = function(script,callback) {
	  var ccuIP =  this.hm_layer.ccuIP;
	  var that = this;
	  var post_options = {
      host: ccuIP,
      port: "8181",
      path: "/tclrega.exe",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": script.length
      },
    };

    var post_req = http.request(post_options, function(res) {
      var data = "";
      
      res.setEncoding("binary");
      
      res.on("data", function(chunk) {
        data += chunk.toString();
      });
      
      res.on("end", function() {
        var pos = data.lastIndexOf("<xml><exec>");
        var response = (data.substring(0, pos));
        that.log.debug("Rega Response %s",response);
        callback(response);
      });

      
    });


    post_req.on("error", function(e) {
	    that.log.warn("Error " + e + "while executing rega script " + ls);
        callback(undefined);
    });

    post_req.on("timeout", function(e) {
	    that.log.warn("timeout while executing rega script");
        callback(undefined);
    });
    
	post_req.setTimeout(1000);
	this.log.debug("RegaScript %s",script);
    post_req.write(script);
    post_req.end();
}


LogicalBridge.prototype.doCache = function(adress,datapoint,value) {
  var adr = adress + "." + datapoint;
  var el = this.cache[adr];
  if (!el) {
	  el = {"v":value,"t":Date.now()};
  } else {
	  el["l"] = el['v'];
	  el["v"] = value;
	  el["t"] = Date.now();
  }
  this.cache[adr]=el;
}

LogicalBridge.prototype.reInitScripts = function() {
	var that = this;
	// Kill all and Init 
	this.scripts = {};
    this.subscriptions = [];
    // Kill All Scheduled Jobs

    Object.keys(scheduler.scheduledJobs).forEach(function(job){
	   scheduler.cancelJob(job); 
    });
    
    var l_path = this.configuration.storagePath();
    this.loadScriptDir(l_path + "/scripts/");
    
    scheduler.scheduleJob("[Intern] Astro Calculation",'0 0 * * *', function () {
    // re-calculate every day
    	that.calculateSunTimes();
    // schedule events for this day
    	that.sunEvents.forEach(function (event) {
        	that.sunScheduleEvent(event);
    	});
    	
        that.log.info('re-scheduled', that.sunEvents.length, 'sun events');
    });

}

LogicalBridge.prototype.loadScriptDir = function(pathName) {
    var that = this;
    
    fs.readdir(pathName, function (err, data) {
        if (err) {
            if (err.errno = 34) {
                that.log.error('directory %s not found',path.resolve(pathName));
            } else {
                that.log.error('readdir %s %s', pathName, err);
            }

        } else {
            data.sort().forEach(function (file) {
                if (file.match(/\.(js)$/)) {
                    that.loadScript(path.join(pathName, file));
                }
            });
            
        }
    });
}


LogicalBridge.prototype.loadScript = function(filename) {
	var that = this;
	
	if (this.scripts[filename]) {
        this.log.error('Huuuh %s already loaded?!',filename);
        return;
    }
    
    this.log.info('loading script %s',filename);
    
    fs.readFile(filename, function (err, src) {
     
        if (err && err.code === 'ENOENT') {
            that.log.error('%s not found',filename);
        } else if (err) {
            that.log.error(file, err);
        } else {
	        
	        if (filename.match(/\.js$/)) {
                // Javascript
                that.scripts[filename] = that.createScript(src, filename);
            }
            if (that.scripts[filename]) {
                that.runScript(that.scripts[filename], filename);
            }
	    }
	});    
}

LogicalBridge.prototype.createScript = function(source, name) {

    this.log.debug('compiling %s',name);
    try {
        if (!process.versions.node.match(/^0\.10\./)) {
            // Node.js >= 0.12, io.js
            return new vm.Script(source, {filename: name});
        } else {
            // Node.js 0.10.x
            return vm.createScript(source, name);
        }
    } catch (e) {
        this.log.error(name, e.name + ':', e.message);
        return false;
    }
}


LogicalBridge.prototype.sendValueRPC = function(adress,datapoint,value,callback) {
	var that = this;
	this.client.methodCall("setValue",[adress,datapoint,value], function(error, value) {
		that.doCache(adress,datapoint,value);
		callback();
	});
}

LogicalBridge.prototype.internal_getState = function(adress,datapoint,callback) {
	var that = this;
	this.client.methodCall("getValue", [adress,datapoint], function(error, value) {
		that.doCache(adress,datapoint,value);
		callback(value);
	});
}

LogicalBridge.prototype.get_State = function(adress,datapoint,callback) {
  this.internal_getState(adress,datapoint,callback);
}

LogicalBridge.prototype.get_Value = function(adress,datapoint,callback) {
	var adr = adress + "." + datapoint;
	var dp = this.cache[adr];
	if (dp) {
		callback(dp['v']);
	} else {
		this.internal_getState(adress,datapoint,callback);
	}
}

LogicalBridge.prototype.set_Variable = function(name,value,callback) {
   var script = "var x = dom.GetObject('"+name+"');if (x){x.State("+value+");}";
   this.regaCommand(script,callback);
}

LogicalBridge.prototype.get_Variable = function(name,callback) {
   var script = "var x = dom.GetObject('"+name+"');if (x){WriteLine(x.Variable())	;}";
   this.regaCommand(script,callback);
}

LogicalBridge.prototype.get_Variables = function(variables,callback) {
   var that = this;
   var script = "object x;";
   variables.forEach(function (variable){
   	script = script + "x=dom.GetObject('" + variable + "');if (x){WriteLine(x#'\t\t'#x.Variable()#'\t\t'#x.Timestamp());}"
   });
   
   var vr_result = {};
   this.regaCommand(script,function (result){
	   var arr = result.split("\r\n");
	   
	   arr.forEach(function(var_line){
		   var vr = var_line.split("\t\t");
		   var nv = {};
		   if ((vr.length>1) && (vr[0]) && (vr[0]!='')) {
			   nv.value = vr[1];
			   if (vr.length>2) {
				   nv.timestamp = moment.utc(vr[2]).valueOf();
			   }
			   vr_result[vr[0]]=nv;
		   }
	   });
	   callback(vr_result);
   });
}


LogicalBridge.prototype.set_Variables = function(variables,callback) {
   var that = this;
   var script = "object x;";
   Object.keys(variables).forEach(function(key) {
   	var vv = variables[key];
   	if (vv) {
       script = script + "x=dom.GetObject('" + key + "');if (x){x.State("+vv+");}"
   	}
   });
   this.regaCommand(script,function (result){
	   callback();
   });
}


LogicalBridge.prototype.ccuEvent = function(adress,datapoint,value) {
   this.processSubscriptions(adress,datapoint,value );
}


LogicalBridge.prototype.processSubscriptions = function(adress,datapoint,value) {
  var that = this;
  
  var eventSource = adress+"."+datapoint;
  this.subscriptions.forEach(function (subs) {

	  var options = subs.options || {};
      var delay;
      var match;

	  if (typeof subs.source === 'string') {
            match = (subs.source == eventSource);
        } else if (subs.source instanceof RegExp) {
            match = eventSource.match(subs.source);
        }

      if (typeof subs.callback === 'function' && match) {
      		
      		delay = 0;
            if (options.shift) delay += ((parseFloat(options.shift) || 0) * 1000);
            if (options.random) delay += ((parseFloat(options.random) || 0)  * Math.random() * 1000);

            delay = Math.floor(delay);
            setTimeout(function () {
                subs.callback(subs.source, value);
            }, delay);

        }	  
	  
  });
}

LogicalBridge.prototype.calculateSunTimes = function() {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0, 0);
    var yesterday = new Date(today.getTime() - 86400000); //(24 * 60 * 60 * 1000));
    var tomorrow = new Date(today.getTime() + 86400000); //(24 * 60 * 60 * 1000));
    var lat = this.configuration.getValueForPluginWithDefault(this.name,"latitude",52.520008); // Default is Berlin ;o)
    var lon = this.configuration.getValueForPluginWithDefault(this.name,"longitude",13.404954);

    this.sunTimes = [
        suncalc.getTimes(yesterday, lat, lon),
        suncalc.getTimes(today, lat, lon),
        suncalc.getTimes(tomorrow, lat, lon)
    ];
    this.log.debug('calculatedSunTimes', this.sunTimes);
}


LogicalBridge.prototype.sunScheduleEvent = function(obj, shift) {
    // shift = -1 -> yesterday
    // shift = 0 -> today
    // shift = 1 -> tomorrow
    var event = this.sunTimes[1 + (shift || 0)][obj.pattern];
    log.debug('sunScheduleEvent', obj.pattern, obj.options, shift);
    var now = new Date();

    if (event.toString() !== 'Invalid Date') {
        // Event will occur today

        if (obj.options.shift) event = new Date(event.getTime() + ((parseFloat(obj.options.shift) || 0) * 1000));

        if ((event.getDate() !== now.getDate()) && (typeof shift === 'undefined')) {
            // event shifted to previous or next day
            this.sunScheduleEvent(obj, (event < now) ? 1 : -1);
            return;
        }

        if ((now.getTime() - event.getTime()) < 1000) {
            // event is less than 1s in the past or occurs later this day

            if (obj.options.random) {
                event = new Date(
                    event.getTime() +
                    (Math.floor((parseFloat(obj.options.random) || 0) * Math.random()) * 1000)
                );
            }

            if ((event.getTime() - now.getTime()) < 1000)  {
                // event is less than 1s in the future or already in the past
                // (options.random may have shifted us further to the past)
                // call the callback immediately!
                obj.domain.bind(obj.callback)();

            } else {
                // schedule the event!
                scheduler.scheduleJob(event, obj.domain.bind(obj.callback));
                this.log.debug('scheduled', obj.pattern, obj.options, event);
            }

        } else {
            this.log.debug(obj.pattern, obj.options, 'is more than 1s the past', now, event);
        }

    } else {
        this.log.debug(obj.pattern, 'doesn\'t occur today');
    }
}



LogicalBridge.prototype.triggerScript = function(script) {
  var that = this;
  var found = false;
    
  
  // First check if we have to run out from subscriptions
  
  this.subscriptions.forEach(function (subs) {
    var match = (subs.file == script);

  		if (typeof subs.callback === 'function' && match) {
	  		that.log.debug("Found %s with a subscription - run the then part",script);
	  		subs.callback(null,null);
		    found = true;
		}
  });
  
  if (!found) {
	  // Not found as a Subscripttion .. get the script and run manually
  var l_path = this.configuration.storagePath();
  var sfile = l_path + "/scripts/" + script;
  var oscript = this.scripts[sfile];
  if (oscript) {
	  // Check Callback and Run it
	  	
	  	this.log.debug("Not found in subscriptions - load and run %s",sfile);
		fs.readFile(sfile, function (err, src) {
     
        if (err && err.code === 'ENOENT') {
            that.log.error('%s not found',sfile);
        } else if (err) {
            that.log.error(file, err);
        } else {
	        
	        if (sfile.match(/\.js$/)) {
                // Javascript
                var triggeredScript = that.createScript(src, sfile);
                that.runScript(triggeredScript, sfile);
            }
	    }
	});    
  }
	  
  }
  this.log.debug("Subscriptions : ",JSON.stringify(this.subscriptions));
}

LogicalBridge.prototype.runScript = function(script, name) {

    var scriptDir = path.dirname(path.resolve(name));
	var that = this;
	
    this.log.debug('creating domain %s',name);
    var scriptDomain = domain.create();

    this.log.debug('creating sandbox %s',name);

    var Sandbox = {

        global: _global,

        setTimeout: setTimeout,
        setInterval: setInterval,
        clearTimeout: clearTimeout,
        clearInterval: clearInterval,

        Buffer: Buffer,

        require: function (md) {
	        
	        if (modules[md]) return modules[md];
            
            try {
                var tmp;
                if (md.match(/^\.\//) || md.match(/^\.\.\//)) {
                    tmp = './' + path.relative(__dirname, path.join(scriptDir, md));
                } else {
                    tmp = md;
                    if (fs.existsSync(path.join(scriptDir, 'node_modules', md, 'package.json'))) {
                        tmp = './' + path.relative(__dirname, path.join(scriptDir, 'node_modules', md));
                        tmp = path.resolve(tmp);
                    }
                }
                Sandbox.log.debug('require', tmp);
                modules[md] = require(tmp);
                return modules[md];

            } catch (e) {
                var lines = e.stack.split('\n');
                var stack = [];
                for (var i = 6; i < lines.length; i++) {
                    if (lines[i].match(/runInContext/)) break;
                    stack.push(lines[i]);
                }
                log.error(name + ': ' + e.message + '\n' + stack);
            }
	        
        },
        
        log: {
            /**
             * Log a debug message
             * @memberof log
             * @method debug
             * @param {...*}
             */
            debug: function () {
                var args = Array.prototype.slice.call(arguments);
                args.unshift(name + ':');
                that.log.debug.apply(that.log, args);
            },
            /**
             * Log an info message
             * @memberof log
             * @method info
             * @param {...*}
             */
            info: function () {
                var args = Array.prototype.slice.call(arguments);
                args.unshift(name + ':');
                that.log.info.apply(that.log, args);
            },
            /**
             * Log a warning message
             * @memberof log
             * @method warn
             * @param {...*}
             */
            warn: function () {
                var args = Array.prototype.slice.call(arguments);
                args.unshift(name + ':');
                that.log.warn.apply(that.log, args);
            },
            /**
             * Log an error message
             * @memberof log
             * @method error
             * @param {...*}
             */
            error: function () {
                var args = Array.prototype.slice.call(arguments);
                args.unshift(name + ':');
                that.log.error.apply(that.log, args);
            }
        },
        
        link: function Sandbox_link(source, target, /* optional */ value) {
            Sandbox.subscribe(source, function (source, val) {
                val = (typeof value === 'undefined') ? val : value;
                that.log.debug('logic-link', source, target, val);
                Sandbox.setValue(target, val);
            });
        },
        
        subscribe:  function Sandbox_subscribe(source, /* optional */ options, callback) {
            if (typeof source === 'undefined') {
                throw(new Error('argument source missing'));
            }

            if (arguments.length === 2) {

                if (typeof arguments[1] !== 'function') throw new Error('callback is not a function');

                callback = arguments[1];
                options = {};


            } else if (arguments.length === 3) {

                if (typeof arguments[2] !== 'function') throw new Error('callback is not a function');
                options = arguments[1] || {};
                callback = arguments[2];

            } else if (arguments.length > 3) {
                throw(new Error('wrong number of arguments'));
            }

            if (typeof source === 'string') {
				
				var tmp = source.split('.');
				// Check first Value for hmvirtual
			    that.log.debug("Source is %s",JSON.stringify(tmp));
				if ((tmp.length>2) && (tmp[0].toLowerCase()=="hmvirtual")) {
					
				   var channel = tmp[1];
				   // Bind to channel change events
				   that.processLogicalBinding(channel);
				}
                
                var fn = path.basename(name)
                that.subscriptions.push({file:fn, source: source, options: options, callback: (typeof callback === 'function') && scriptDomain.bind(callback)});

            } else if (typeof source === 'object' && source.length) {

                source = Array.prototype.slice.call(source);
                source.forEach(function (tp) {
	                Sandbox.subscribe(tp, options, callback);
                });

            }

        },
        
        
        setVariable:   function Sandbox_setVariable(varname, val) {
        	return new Promise(function (resolve,reject) {
				that.set_Variable(varname,val,function(){
					resolve(val);
				});
	        });
        },
        
        setVariables:   function Sandbox_setVariables(variables) {
        	
        	return new Promise(function (resolve,reject) {
			try {
				that.set_Variables(variables,function(){
					resolve(variables);
				});
			} catch (err) {
				that.log.debug(err);
				reject(err);
			}
	        });
        },

        getVariable:   function Sandbox_getVariable(varname) {
        	return new Promise(function (resolve,reject) {
				that.get_Variable(varname,function(value){
					resolve(value);
				});
	        }	);
        },

        getVariables:   function Sandbox_get_Variables(varnames) {
        	return new Promise(function (resolve,reject) {
				that.get_Variables(varnames,function(values){
					resolve(values);
				});
	        }	);
        },
        

        setValue:   function Sandbox_setValue(target, val) {

			return new Promise(function (resolve,reject) {

            if (typeof target === 'object' && target.length) {
                target = Array.prototype.slice.call(target);
                target.forEach(function (tp) {
                    Sandbox.setValue(tp, val);
                    resolve(value);
                });
                return;
            }

			var tmp = target.split('.');
			// First Part should be the interface
			// Second the Adress
			// third the Datapoint
			if (tmp.length>2) {
				
				if (tmp[0].toLowerCase()==that.interface.toLowerCase()) {
					var adress = tmp[1];
					var datapointName = tmp[2];
					that.sendValueRPC (adress,datapointName,val,function(){
						resolve();
					});  
				}

				if (tmp[0].toLowerCase()=="hmvirtual") {
					var adress = tmp[1];
					var datapointName = tmp[2];
					var channel = that.hm_layer.channelWithAdress(adress);
					if (channel) {
						that.log.debug("Channel found set Value");
						channel.setValue(datapointName,val);
						channel.updateValue(datapointName,val,true);
						resolve();
					} else {
						that.log.error("Channel %s not found",adress);
					}
				}
				
				
			} else {
				that.log.error("Target %s seems not to be value",target);
				reject(undefined);
			}
			
		  });
		},
		
		getValue: function Sandbox_getValue(target) {
			
			return new Promise(function (resolve,reject) {
				
   			var tmp = target.split('.');
   			//if (typeof callback === 'function') {
			// First Part should be the interface
			// Second the Adress
			// third the Datapoint
			if (tmp.length>2) {
				if (tmp[0].toLowerCase()==that.interface.toLowerCase()) {
					var adress = tmp[1];
					var datapointName = tmp[2];
				    that.get_Value(adress,datapointName,function(value){
					    resolve(value);
				    });
				}

				if (tmp[0].toLowerCase()=="hmvirtual") {
					var adress = tmp[1];
					var datapointName = tmp[2];
					var channel = that.hm_layer.channelWithAdress(adress);
					if (channel) {
						resolve(channel.getValue(datapointName));
					}
				}
				
				
			} else {
				that.log.error("Target %s seems not to be value",target);
				reject(undefined);
			}
				
			});
		  //}
		},

		getState: function Sandbox_getState(target,callback) {
		
			return new Promise(function (resolve,reject) {
   			var tmp = target.split('.');
			// First Part should be the interface
			// Second the Adress
			// third the Datapoint
			if (tmp.length>2) {
				
				if (tmp[0].toLowerCase()==that.interface.toLowerCase()) {
					var adress = tmp[1];
					var datapointName = tmp[2];
				    that.get_State(adress,datapointName,function(value){
					    resolve(value);
				    });
				}

				if (tmp[0].toLowerCase()=="hmvirtual") {
					var adress = tmp[1];
					var datapointName = tmp[2];
					var channel = that.hm_layer.channelWithAdress(adress);
					if (channel) {
						resolve(channel.getValue(datapointName));
					}
				}
				
				
			} else {
				that.log.error("Target %s seems not to be value",target);
				reject(undefined);
			}

			});
		},
		
		
		schedule:   function Sandbox_schedule(pattern, /* optional */ options, callback) {

            if (arguments.length === 2) {
                if (typeof arguments[1] !== 'function') throw new Error('callback is not a function');
                callback = arguments[1];
                options = {};
            } else if (arguments.length === 3) {
                if (typeof arguments[2] !== 'function') throw new Error('callback is not a function');
                options = arguments[1] || {};
                callback = arguments[2];
            } else {
                throw(new Error('wrong number of arguments'));
            }

            if (typeof pattern === 'object' && pattern.length) {
                pattern = Array.prototype.slice.call(topic);
                pattern.forEach(function (pt) {
                    Sandbox.sunSchedule(pt, options, callback);
                });
                return;
            }

            that.log.debug('schedule()', pattern, options, typeof callback);
			if (options.name==undefined) {
				options.name = "JOB:314";
			}
            if (options.random) {
                scheduler.scheduleJob(options.name, pattern, function () {
                    setTimeout(scriptDomain.bind(callback), (parseFloat(options.random) || 0) * 1000 * Math.random());
                });
            } else {
	            var job = scheduler.scheduleJob(options.name,pattern, scriptDomain.bind(callback));
            }


        },
        
        sunSchedule: function Sandbox_sunSchedule(pattern, /* optional */ options, callback) {

            if (arguments.length === 2) {
                if (typeof arguments[1] !== 'function') throw new Error('callback is not a function');
                callback = arguments[1];
                options = {};
            } else if (arguments.length === 3) {
                if (typeof arguments[2] !== 'function') throw new Error('callback is not a function');
                options = arguments[1] || {};
                callback = arguments[2];
            } else {
                throw new Error('wrong number of arguments');
            }

            if ((typeof options.shift !== 'undefined') && (options.shift < -86400 || options.shift > 86400)) {
                throw new Error('options.shift out of range');
            }

            if (typeof pattern === 'object' && pattern.length) {
                pattern = Array.prototype.slice.call(topic);
                pattern.forEach(function (pt) {
                    Sandbox.sunSchedule(pt, options, callback);
                });
                return;
            }

            that.log.debug('sunSchedule', pattern, options);

            var event = sunTimes[0][pattern];
            if (typeof event === 'undefined') throw new Error('unknown suncalc event ' + pattern);

            var obj = {
                pattern: pattern,
                options: options,
                callback: callback,
                context: Sandbox,
                domain: scriptDomain
            };

            that.sunEvents.push(obj);

            that.sunScheduleEvent(obj);

        }
        
        
    };
    
     Sandbox.console = {
        log: Sandbox.log.info,
        error: Sandbox.log.error
    };


    this.log.debug('contextifying sandbox %s',name);
    var context = vm.createContext(Sandbox);


    scriptDomain.on('error', function (e) {
        if (!e.stack) {
            that.log.error.apply(log, [name + ' unkown exception']);
            return;
        }
        var lines = e.stack.split('\n');
        var stack = [];
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].match(/\[as runInContext\]/)) break;
            stack.push(lines[i]);
        }

        that.log.error.apply(that.log, [name + ' ' + stack.join('\n')]);
    });

    scriptDomain.run(function () {
        that.log.debug('running %s',name);
        try {
	        script.runInContext(context);
        } catch (err) {
	        that.log.error("--------------------");
			that.log.error("ERROR LOADING SCRIPT %s",name);
			that.log.error(err.stack);
			that.log.error("--------------------");
			
        }
    });

}

LogicalBridge.prototype.processLogicalBinding = function(source_adress) {
  var channel = this.hm_layer.channelWithAdress(source_adress);
  var that = this;
  that.log.debug("uhh someone is intrested in my value changes");
  if (channel) {
	  
  channel.on('event_channel_value_change', function(parameter){
	  parameter.parameters.forEach(function (pp){
		  that.processSubscriptions("HMVirtual."+parameter.channel,pp.name,pp.value);
	  });
  });
  }
}






LogicalBridge.prototype.getValue = function(adress) {
   return this.elements[adress];
}

LogicalBridge.prototype.shutdown = function() {

	
}

LogicalBridge.prototype.handleConfigurationRequest = function(dispatched_request) {
	var requesturl = dispatched_request.request.url;
	var queryObject = url.parse(requesturl,true).query;
	if (queryObject["do"]!=undefined) {
		
		switch (queryObject["do"]) {
		
		  case "reload": {
			  this.reInitScripts();
		  }

		  case "trigger": {
			  this.triggerScript(queryObject["script"]);
		  }
		  
		  break;
		}
	}
	
	var strScripts = "";
	var strSchedulers = "";
	var that = this;
	
	var itemtemplate = dispatched_request.getTemplate(this.plugin.pluginPath , "list_item_tmp.html",null);

	
	Object.keys(scheduler.scheduledJobs).forEach(function(job){
	  strSchedulers = strSchedulers + dispatched_request.fillTemplate(itemtemplate,{"item":job});
	});	
	
	Object.keys(this.scripts).forEach(function(script){
	  strScripts = strScripts + dispatched_request.fillTemplate(itemtemplate,{"item":path.basename(script)});
	});
	
	dispatched_request.dispatchFile(this.plugin.pluginPath , "index.html",{"scripts":strScripts,"schedules":strSchedulers});
}


module.exports = {
  LogicalBridge : LogicalBridge
}