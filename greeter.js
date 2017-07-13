/* jslint bitwise: true */
/* jshint esversion: 6 */

'use strict';

const Defaults = {
  host:         '127.0.0.1',
  loglevel:     'debug',
  port:         1337,
  reconnect:    true,
  slackChannel: '#newavatars',
  slackToken:   ''
};

const fs = require('fs');
const log = require('winston');

const RtmClient = require('@slack/client').RtmClient;
const CLIENT_EVENTS = require('@slack/client').CLIENT_EVENTS;
const RTM_EVENTS = require('@slack/client').RTM_EVENTS;

const HabiBot = require('./habibot');

const Argv = require('yargs')
  .usage('Usage: $0 [options]')
  .help('help')
  .option('help', { alias: '?', describe: 'Get this usage/help information.' })
  .option('host', { alias: 'h', default: Defaults.host, describe: 'Host name or address of the Elko server.' })
  .option('loglevel',  { alias: ';', default: Defaults.loglevel, describe: 'Log level name. (see: npm winston)'})
  .option('port', { alias: 'p', default: Defaults.port, describe: 'Port number for the Elko server.' })
  .option('context', { alias: 'c', describe: 'Context to enter.' })
  .option('greetingFile', { alias: 'g', describe: 'File to be played as a greeting.' })
  .option('reconnect', { alias: 'r', default: Defaults.reconnect, describe: 'Whether the bot should reconnect on disconnection.' })
  .option('slackToken', { alias: 's', default: Defaults.slackToken, describe: 'Token for sending user notifications to Slack.' })
  .option('slackChannel', { alias: 'l', default: Defaults.slackChannel, describe: 'Default Slack channel to use for notifications.' })
  .option('username', { alias: 'u', describe: 'Username of this bot.' })
  .argv;

log.level = Argv.loglevel;

const GreeterBot = new HabiBot(Argv.host, Argv.port);
const GreetingText = fs.readFileSync(Argv.greetingFile).toString().split('\n');
const SlackEnabled = false;
//const SlackEnabled = Argv.slackToken !== '';
const SlackClient = new RtmClient(Argv.slackToken);

let SlackChannelId;
SlackClient.on(CLIENT_EVENTS.RTM.AUTHENTICATED, (rtmStartData) => {
  for (const c of rtmStartData.channels) {
    if (c.is_member && c.name === Argv.slackChannel) { SlackChannelId = c.id }
  }
});

SlackClient.on(RTM_EVENTS.MESSAGE, function handleRtmMessage(message) {
  if (message.channel.name === Argv.slackChannel) {
    GreeterBot.send({
      op: 'SPEAK',
      to: 'ME',
      esp: 0,
      text: `@${message.user}: ${message.text}`
    });
  }
});

GreeterBot.on('APPEARING_$', function(bot, msg) {
  var avatar = bot.getNoid(msg.appearing);
  if (avatar == null) {
    log.error('No avatar found at noid: %s', msg.appearing);
    return;
  }

  // Announces new user to Slack.
  if (SlackEnabled) {
    SlackClient.sendMessage(`New user arrived: ${avatar.name}`, SlackChannelId);
  }

  // Waves to new Avatar.
  bot.send({
    op: 'POSTURE',
    to: 'ME',
    pose: 141
  })
    .then(function() {
      bot.sendWithDelay({
        op: 'OBJECTSPEAK_$',
        type: 'private',
        noid: avatar.mods[0].noid,
        text: line,
        speaker: '$ME.noid$'
      }, 500);
    });
});

GreeterBot.on('SPEAK$', function(bot, msg) {
  if (SlackEnabled) {
    var avatar = bot.getNoid(msg.noid);
    if (avatar != null) {
      SlackClient.sendMessage(`${avatar.name}: ${msg.text}`, SlackChannelId);
    }
  }
});

GreeterBot.on('connected', function(bot) {
  log.debug('GreeterBot connected.');
  bot.send({
    op: 'entercontext',
    to: 'session',
    context: Argv.context,
    user: 'user-' + Argv.username
  })
});

GreeterBot.on('enteredRegion', function(bot, me) {
  bot.send({
    op: 'WALK',
    to: 'ME',
    x: 84,
    y: 131,
    how: 1
  })
    .then(function() {
      bot.sendWithDelay({
        op: 'POSTURE',
        to: 'ME',
        pose: 141
      }, 5000);
    })
    .then(function() {
      bot.send({
        op: 'SPEAK',
        to: 'ME',
        esp: 0,
        text: "Hey there! I'm Phil, the greeting bot!"
      });
    });
});

GreeterBot.connect();

if (SlackEnabled) {
  SlackClient.start();
}

if (Argv.reconnect) {
  GreeterBot.on('disconnected', function(bot) {
    bot.connect();
  });
}
