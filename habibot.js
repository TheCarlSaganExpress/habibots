/* jslint bitwise: true */
/* jshint esversion: 6 */

'use strict';

const log = require('winston');
const net = require('net');

const Queue = require('promise-queue');

const constants = require('./constants');
const util = require('./util');


const DirectionToPoseId = {
  LEFT:    254,
  RIGHT:   255,
  FORWARD: 146,
  BEHIND:  143,
};

const AvatarPostures = {
  WAVE:        141,
  POINT:       136,
  EXTEND_HAND: 148,
  JUMP:        139,
  BEND_OVER:   134,
  STAND_UP:    135,
  PUNCH:       140,
  FROWN:       142,
}

const DefaultHabiBotConfig = {
  shouldReconnect: true,
};


class HabiBot {

  constructor(host, port, username) {
    this.host = host;
    this.port = port;
    this.username = username;

    this.server = null;
    this.connected = false;

    // Ensures that only 1 Elko request is in flight at any given time.
    // We're talking to the 80's after all...
    this.actionQueue = new Queue(1, Infinity);

    this.config = util.clone(DefaultHabiBotConfig);

    this.callbacks = {
      connected: [],
      delete: [],
      disconnected: [],
      enteredRegion: [],
      msg: [],
    };

    this.clearState();

    log.debug('Constructed HabiBot @%s:%d: %j', this.host, this.port, this.config);
  }

  static newWithConfig(host, port, username, config) {
    var bot = new HabiBot(host, port, username);
    Object.assign(bot.config, config);
    return bot;
  }

  /**
   * Connects this HabiBot to the Neohabitat server if it is not yet connected.
   */
  connect() {
    if (this.host === undefined || this.port === undefined) {
      log.error('No host or port specified: %s:%d', this.host. this.port);
      return;
    }

    if (!this.connected) {
      var scope = this;
      scope.clearState();
      this.server = net.connect(this.port, this.host, () => {
        scope.connected = true;
        log.info('Connected to server @%s:%d', scope.host, scope.port);
        log.debug('Running callbacks for connect @%s:%d', scope.host, scope.port);
        for (var i in scope.callbacks.connected) {
          scope.callbacks.connected[i](scope);
        }
      });
      this.server.on('data', this.processData.bind(this));
      this.server.on('end', this.onDisconnect.bind(this));
    }
  }

  /**
   * Turns the HabiBot into an Avatar if it is currently a Ghost.
   * @returns {Promise}
   */
  corporate() {
    var scope = this;
    if (!this.isGhosted()) {
      return Promise.resolve();
    }
    return scope.send({
      op: 'CORPORATE',
      to: 'GHOST',
    })
      .then(() => {
        // Hardwaits 10 seconds for all C64 clients to load imagery.
        return scope.wait(10000);
      });
  }

  /**
   * Turns the HabiBot's Avatar into a Ghost, useful for bots which only need to monitor
   * events in a Region.
   * @returns {Promise}
   */
  discorporate() {
    return this.send({
      op: 'DISCORPORATE',
      to: 'ME',
    });
  }

  /**
   * Runs an Avatar posture animation.
   * @param {string} posture One of WAVE, POINT, EXTEND_HAND, JUMP, BEND_OVER, STAND_UP, PUNCH, or FROWN
   * @returns {Promise}
   */
  doPosture(posture) {
    var scope = this;
    var postureUpper = posture.toUpperCase();
    if (postureUpper in AvatarPostures) {
      log.debug('Bot @%s:%d running posture animation: %s',
          scope.host, scope.port, postureUpper);
      return scope.send({
        op:   'POSTURE',
        to:   'ME',
        pose: AvatarPostures[postureUpper],
      }).then(() => { scope.wait(2000) });
    }
    return Promise.reject(`Invalid posture: ${posture}`);
  }

  /**
   * Ensures that the current HabiBot's Avatar is corporated, e.g. not a ghost.
   * Useful to call in enteredRegion callbacks.
   * @returns {Promise}
   */
  ensureCorporated() {
    return this.tryEnsureCorporated(0);
  }

  /**
   * Faces the HabiBot's Avatar towards a provided direction:
   * @param {string} direction One of LEFT, RIGHT, FORWARD, BEHIND
   * @returns {Promise}
   */
  faceDirection(direction) {
    var directionUpper = direction.toUpperCase();
    if (directionUpper in DirectionToPoseId) {
      log.debug('Bot @%s:%d facing direction: %s', this.host, this.port, directionUpper);
      return this.send({
        op:   'POSTURE',
        to:   'ME',
        pose: DirectionToPoseId[directionUpper],
      });
    }
    return Promise.reject(`Invalid direction: ${direction}`);
  }

  /**
   * Returns true if this HabiBot's Avatar is currently in Ghost form.
   * @returns {boolean}
   */
  isGhosted() {
    var avatar = this.getAvatar();
    if (avatar != null) {
      return avatar.mods[0].amAGhost;
    }
    return false;
  }

  /**
   * Returns the Habitat object corresponding to this HabiBot's Avatar; returns null if
   * none was found.
   * @returns {Object} Habitat object of this HabiBot's avatar if found, null otherwise
   */
  getAvatar() {
    if ('ME' in this.names) {
      return this.history[this.names.ME].obj;
    }
    return null;
  }

  /**
   * Obtains the noid of the HabiBot's Avatar.
   * @returns {int} noid of the HabiBot's Avatar, -1 if no Avatar was found
   */
  getAvatarNoid() {
    var avatar = this.getAvatar();
    if (avatar != null) {
      return avatar.mods[0].noid;
    }
    return -1;
  }

  /**
   * Returns the direction of a Habitat object relative to the HabiBot's current region
   * position.
   * @param {Object} obj Habitat object to return direction of
   * @returns {string} LEFT, RIGHT, FORWARD, or UNKNOWN
   */
  getDirection(obj) {
    var myAvatar = this.getAvatar();
    if (myAvatar != null && 
        obj != null &&
        'mods' in obj &&
        obj.mods.length > 0) {
      var avatarMod = myAvatar.mods[0];
      var mod = obj.mods[0];
      if ('x' in mod) {
        if (mod.x < avatarMod.x) {
          return constants.LEFT;
        } else if (mod.x == avatarMod.x) {
          return constants.FORWARD;
        } else {
          return constants.RIGHT;
        }
      }
      return constants.UNKNOWN;
    }
    return constants.UNKNOWN;
  }

  /**
   * Returns the direction of the Habitat object corresponding to the provided noid
   * relative to the HabiBot's current region position.
   * @param {int} noid noid of Habitat object to return direction of
   * @returns {string} LEFT, RIGHT, FORWARD, or UNKNOWN
   */
  getDirectionOfNoid(noid) {
    return this.getDirection(this.getNoid(noid));
  }

  /**
   * Returns the Habitat mod corresponding to a provided noid.
   * @param {int} noid noid of a Habitat object
   * @returns {Object} Habitat mod if an object is found, null otherwise
   */
  getMod(noid) {
    return this.getNoid(noid).mods[0];
  }

  /**
   * Returns the Habitat object corresponding to a provided noid.
   * @param {int} noid noid of a Habitat object
   * @returns {Object} Habitat object is an object is found, null otherwise
   */
  getNoid(noid) {
    if (noid in this.noids) {
      log.debug('Object at noid %d: %j', noid, this.noids[noid]);
      return this.noids[noid];
    } else {
      log.error('Could not find noid: %s', noid);
      return null;
    }
  }

  /**
   * Moves the HabiBot to the provided context name.
   * @param {string} context Context to move HabiBot to
   * @returns {Promise}
   */
  gotoContext(context) {
    return this.send({
      op: 'entercontext',
      to: 'session',
      context: context,
      user: `user-${this.username}`,
    });
  }

  /**
   * Registers a callback for a Habitat event type, which can include one of the below
   * built-in event types or a Neohabitat server message, such as <tt>APPEARING_$</tt> or
   * <tt>SPEAK$</tt>.
   *
   * <b>Built-in event types:</b>
   * <ul>
   *   <li><b>connected</b> - The HabiBot has connected to the Neohabitat server</li>
   *   <li><b>delete</b> - A Habitat object in the current region has been deleted</li>
   *   <li><b>disconnected</b> - The HabiBot has disconnect from the Neohabitat server</li>
   *   <li><b>enteredRegion</b> - The HabiBot has entered a Habitat region</li>
   *   <li><b>msg</b> - The HabiBot has received a message from the Neohabitat server</li>
   * </ul>
   *
   * Callbacks typically take two parameters, the first being an instance of this HabiBot
   * and the second being the JSON object received from the server, if present:
   *
   * <pre>
   * const HabiBot = require('habibot');
   * const PhilCollinsBot = new HabiBot('127.0.0.1', 1337, 'pcollins');
   * PhilCollinsBot.on('APPEARING_$', (bot, msg) => {
   *   // msg: {"type":"broadcast","noid":0,"op":"APPEARING_$","appearing":170}
   *   var avatar = bot.getNoid(msg.appearing);
   *   bot.say(`Hey ${avatar.name}! I'm Phil Collins.`);
   * });
   * </pre>
   *
   * <b>Please note</b>, the <tt>connected</tt> and <tt>disconnected</tt> callbacks take
   * only one callback:
   *
   * <pre>
   * const HabiBot = require('habibot');
   * const PhilCollinsBot = new HabiBot('127.0.0.1', 1337, 'pcollins');
   * PhilCollinsBot.on('connected', (bot) => {
   *   // Go to the Fountain region upon first connect.
   *   bot.gotoContext('context-Downtown_5f');
   * });
   * </pre>
   * @param {string} eventType Habitat event type
   * @param {function} callback callback to register for provided Habitat event type
   */
  on(eventType, callback) {
    if (eventType in this.callbacks) {
      this.callbacks[eventType].push(callback);
    } else {
      this.callbacks[eventType] = [callback];
    }
  }

  /**
   * Speaks the provided text within the HabiBot's current region.
   * @param {string} text text to speak
   * @return {Promise}
   */
  say(text) {
    return this.send({
      op: 'SPEAK',
      to: 'ME',
      esp: 0,
      text: text,
    });
  }

  /**
   * Sends the provided Elko message to the Neohabitat server.
   * @param {Object} obj Elko message to send
   * @returns {Promise}
   */
  send(obj) {
    return this.sendWithDelay(obj, 500);
  }

  sendWithDelay(obj, delayMillis) {
    var scope = this;
    return this.actionQueue.add(() => {
      return new Promise((resolve, reject) => {
        if (!scope.connected) {
          reject(`Not connected to ${scope.host}:${scope.port}`);
          return;
        }
        if (obj.to) {
          obj.to = scope.substituteName(obj.to);
        }
        scope.substituteState(obj);
        var msg = JSON.stringify(obj);
        setTimeout(() => {
          log.debug('%s:%s->: %s', scope.host, scope.port, msg.trim());
          scope.server.write(msg + '\n\n', 'UTF8', () => {
            resolve();
          });
        }, delayMillis);
      });
    });
  }

  /**
   * Waits for the provided number of milliseconds, resolving the returned Promise.
   * @param {int} millis number of milliseconds to wait
   * @returns {Promise} promise to be resolved after waiting
   */
  wait(millis) {
    var scope = this;
    return this.actionQueue.add(() => {
      return new Promise((resolve, reject) => {
        log.debug('Bot @%s:%d waiting %d milliseconds', scope.host, scope.port, millis);
        setTimeout(() => {
          resolve();
        }, millis);
      });
    });
  }

  /**
   * Walks the HabiBot's Avatar to the provided (x, y) coordinates.
   * @param {int} x x coordinate to walk to
   * @param {int} y y coordinate to walk to
   * @returns {Promise}
   */
  walkTo(x, y) {
    return this.sendWithDelay({
      op: 'WALK',
      to: 'ME',
      x: x,
      y: y,
      how: 1,
    }, 10000);
  }

  // Private methods:

  /**
   * Tracks an Elko object in <tt>names</tt> by all subsections of its ref for ease of
   * shorthand reference.
   */
  addNames(s) {
    var scope = this;
    s.split('-').forEach((dash) => {
      scope.names[dash] = s;
      dash.split('.').forEach((dot) => {
        scope.names[dot] = s;
      });
    });
  }

  /**
   * Clears all shorthand references to an Elko object.
   */
  clearNames(s) {
    var scope = this;
    s.split('-').forEach((dash) => {
      delete scope.names[dash];
      dash.split('.').forEach((dot) => {
        delete scope.names[dot];
      });
    });
  }

  /**
   * Clears all local HabiBot state.
   */
  clearState() {
    this.names = {};
    this.history = {};
    this.noids = {};
    this.avatars = {};
  }

  onDisconnect() {
    log.info('Disconnected from server @%s:%d...', this.host, this.port);
    this.connected = false;

    log.debug('Running callbacks for disconnect @%s:%d', this.host, this.port);
    for (var i in this.callbacks.disconnected) {
      this.callbacks.disconnected[i](this);
    }

    if (this.config.shouldReconnect) {
      this.connect();
    }
  }

  processData(buf) {
    var framed = false;
    var firstEOL = false;
    var JSONFrame = "";
    var blob = buf.toString();

    var o = null;
    for (var i=0; i < blob.length; i++) {
      var c = blob.charCodeAt(i);
      if (framed) {
        JSONFrame += String.fromCharCode(c);
        if (10 === c) {
          if (!firstEOL) {
            firstEOL = true;
          } else {
            o = this.processElkoPacket(JSONFrame);
            framed    = false;
            firstEOL  = false;
            JSONFrame = "";
          }
        }
      } else {
        if (123 === c) {
          framed = true;
          firstEOL = false;
          JSONFrame = "{";
        } else {
          if (10 !== c) {
            log.debug('IGNORED: %s', c);         
          }
        }
      }
    }
    if (framed) { 
      o = this.processElkoPacket(JSONFrame);
      framed    = false;
      firstEOL  = false;
      JSONFrame = '';
    }

    if (o != null) {
      if (o.op in this.callbacks) {
        log.debug('Running callbacks for op: %s', o.op);
        for (var i in this.callbacks[o.op]) {
          this.callbacks[o.op][i](this, o);
        }
      }
      for (var i in this.callbacks.msg) {
        this.callbacks.msg[i](this, o);
      }

      // Removes the local object reference if a delete message has been sent.
      if (o.op === 'delete') {
        var obj = this.history[o.to];
        this.clearNames(o.to);
        if ('obj' in obj && obj.obj.mods[0].type === 'Avatar') {
          delete this.avatars[obj.obj.name];
        }
        delete this.history[o.to];
      }
    }
  }

  processElkoPacket(s) {
    log.debug('<-%s:%s: %s', this.host, this.port, s.trim());
    return this.scanForRefs(s);
  }

  scanForRefs(s) {
    var scope = this;
    var o = util.parseElko(s);
    
    if (o.to) {
      scope.addNames(o.to);
    }
    if (!o.op) {
      return;
    }

    // HEREIS does not use the same params as make. TODO fix one day.
    if (o.op === 'HEREIS_$') {
      o.obj = o.object;
    }

    if (o.op === 'make' || o.op == 'HEREIS_$') {
      var ref = o.obj.ref;
      scope.addNames(ref);
      scope.history[ref] = o;
      if ('mods' in o.obj && o.obj.mods.length > 0) {
        scope.noids[o.obj.mods[0].noid] = o.obj;
      }
      if (o.you) {
        var split = ref.split('-');
        scope.names.ME = ref;
        scope.names.USER = `${split[0]}-${split[1]}`;
        log.debug('Running callbacks for enteredRegion');
        scope.callbacks.enteredRegion.forEach((callback) => {
          callback(scope, o);
        });
      }
      if (o.obj.mods[0].type === 'Ghost') {
        scope.names.GHOST = ref;
      }
      if (o.obj.mods[0].type === 'Avatar') {
        scope.avatars[o.obj.name] = o.obj;
      }
    }
    return o;
  }

  /**
   * 
   * @param String s The message to be scanned for references ('ref's)
   */
  substituteName(s) {
    return this.names[s] || s;
  }

  /**
   * Telko supports a special state substitution. Any string that starts with "$" will trigger a lookup of the 
   * state via the this.names table. Example "$randy.obj.mod[0].x" will lookup "randy"'s formal ref in the $Names
   * table, then the value of this.history.user-randy-1230958410291.obj.mod[0].x will be substituted. All substitutions will
   * occur in place.
   * 
   * @param {Object} m The object/message that will have it's parameters ($) substituted.
   */
  substituteState(m) {
    for (var name in m) {
      if(m.hasOwnProperty(name)) {
        var prop = m[name];
        if ((typeof prop === 'string' || prop instanceof String) && prop.indexOf('$') !== -1) {
          var chunks = prop.split("$");
          for (var i = 1; i < chunks.length; i++) {
            var value  = chunks[i];
            var keys   = chunks[i].split('.');
            var first  = true;
            var obj;
            var mod;
            for(var j = 0; j < keys.length; j++) {
              var varseg = keys[j];
              if (first) {
                value = this.history[this.substituteName(varseg)];
                if (undefined === value) {
                  // No matching object, so substitute the key's value.
                  value = this.names[varseg] || chunks[i];
                  break;
                }
                if (undefined !== value.obj) {
                  obj = value.obj;
                  if (undefined !== obj.mods & obj.mods.length === 1) {
                    mod = obj.mods[0];
                  }
                }
                first = false;
              } else {
                value = (undefined !== mod && undefined !== mod[varseg]) ? mod[varseg] :
                  (undefined !== obj && undefined !== obj[varseg]) ? obj[varseg] :
                    value[varseg];
              }
            }
            chunks[i] = value;
          }
          if (chunks.length === 2 && chunks[0] === "") {
            // This preserves integer types, which have no leading chars.
            m[name] = chunks[1];
          } else {
            // For in-string substitutions. 
            m[name] = chunks.join("");
          }
        }
      }
    }
  }

  tryEnsureCorporated(curTry) {
    var scope = this;
    if (scope.isGhosted()) {
      // If the Avatar is in ghost form but their Ghost object has not yet
      // come down the wire, retries every 2 seconds 5 times.
      if (!('GHOST' in scope.names)) {
        return new Promise((resolve, reject) => {
          if (curTry < 5) {
            setTimeout(() => {
              scope.ensureCorporated(curTry + 1)
                .then(() => { resolve(); })
                .catch((reason) => { reject(reason); });
            }, 2000);
          } else {
            reject('Could not ensure corporation after 5 tries.');
          }
        });
      }
      return this.corporate();
    }
    return Promise.resolve();
  }

}


module.exports = HabiBot;
