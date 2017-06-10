/*jshint esversion:6, node:true*/
'use strict';

module.exports = require('./lib/manager');

module.exports.Manager = require('./lib/manager');

module.exports.init = require('./lib/init');

module.exports.commands = {
    dataSync: require('./lib/commands/data.sync')
};
