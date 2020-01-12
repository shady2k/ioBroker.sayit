/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';
const utils         = require(__dirname + '/lib/utils'); // Get common adapter utils
const engines       = require(__dirname + '/admin/engines.js');
const Text2Speech   = require(__dirname + '/lib/text2speech');
const Speech2Device = require(__dirname + '/lib/speech2device');
const sayitOptions  = engines.sayitOptions;
const libs          = {};

const adapter = new utils.Adapter({
    name:   'sayit',
    unload: stop
});

process.on('SIGINT', stop);

adapter.on('stateChange', (id, state) => {
    if (state && !state.ack) {
        if (id === adapter.namespace + '.tts.volume') {
            if (adapter.config.type === 'system') {
                speech2device.sayItSystemVolume(state.val);
            } else {
                options.sayLastVolume = state.val;
            }
        } else if (id === adapter.namespace + '.tts.text') {
            if (typeof state.val !== 'string') {
                if (state.val === null || state.val === undefined || state.val === '') {
                    adapter.log.warn('Cannot cache empty text');
                    return;
                }
                state.val = state.val.toString();
            }

            sayIt(state.val);
        } else if (id === adapter.namespace + '.tts.cachetext') {

            if (typeof state.val !== 'string') {
                if (state.val === null || state.val === undefined || state.val === '') {
                    adapter.log.warn('Cannot cache empty text');
                    return;
                }
                state.val = state.val.toString();
            }

            cacheIt(state.val);
        }
    }
});

adapter.on('ready', main);

adapter.on('message', obj => {
    if (obj) processMessage(obj);
    processMessages();
});

function processMessage(obj) {
    if (obj) {
        if (obj.command === 'stopInstance') {
            stop(() => {
                if (obj.callback) {
                    adapter.sendTo(obj.from, obj.command, null, obj.callback);
                }
            });
        } else if (obj.command === 'browseChromecast') {
            try {
                const mdns = require('mdns');

                let browser = mdns.createBrowser(mdns.tcp('googlecast'));

                const result = [];
                browser.on('serviceUp', service => result.push({name: service.name, ip: service.addresses[0]}));
                setTimeout(() => {
                    browser.stop();
                    browser = null;
                    if (obj.callback) {
                        adapter.sendTo(obj.from, obj.command, result, obj.callback);
                    }
                }, 2000);

                browser.start();
            } catch (e) {
                adapter.log.error(e);
                if (obj.callback) adapter.sendTo(obj.from, obj.command, null, obj.callback);
            }
        }
    }
}

function processMessages() {
    adapter.getMessage((err, obj) => {
        if (obj) setTimeout(processMessages, 0);
    });
}

function stop(callback) {
    try {
        if (adapter && adapter.log && adapter.log.info) {
            adapter.log.info('stopping...');
        }
        setTimeout(() => process.exit(), 1000);

        if (typeof callback === 'function') callback();
    } catch (e) {
        process.exit();
    }
}

const options = {
    sayLastVolume: null,
    webLink:       '',
    cacheDir:      ''
};

let sayLastGeneratedText = '';
let list                 = [];
let lastSay              = null;
const text2speech        = new Text2Speech(adapter, libs, options, sayIt);
const speech2device      = new Speech2Device(adapter, libs, options);
const MP3FILE            = __dirname + '/' + adapter.namespace + '.say.mp3';


function mkpathSync(rootpath, dirpath) {
    libs.fs = libs.fs || require('fs');
    // Remove filename
    dirpath = dirpath.split('/');
    dirpath.pop();
    if (!dirpath.length) return;

    for (let i = 0; i < dirpath.length; i++) {
        rootpath += dirpath[i] + '/';
        if (!libs.fs.existsSync(rootpath)) {
            if (dirpath[i] !== '..') {
                libs.fs.mkdirSync(rootpath);
            } else {
                throw 'Cannot create ' + rootpath + dirpath.join('/');
            }
        }
    }
}

function sayFinished(error, duration) {
    if (error) {
        adapter.log.error(error);
    }
    duration = duration || 0;
    if (list.length) {
        adapter.log.debug('Duration "' + list[0].text + '": ' + duration);
    }
    setTimeout(() => {
        // Remember when last text finished
        lastSay = Date.now();
        if (list.length) list.shift();
        if (list.length) {
            sayIt(list[0].text, list[0].language, list[0].volume, true);
        }
    }, duration * 1000);
}

let cacheRunning = false;
let cacheFiles   = [];

function cacheIt(text, language) {
    // process queue
    if (text === true) {
        if (!cacheFiles.length) {
            cacheRunning = false;
            return;
        }
        // get next queued text
        const toCache = cacheFiles.shift();

        text     = toCache.text;
        language = toCache.language;
    } else {
        // new text to cache
        if (!adapter.config.cache) {
            adapter.log.warn('Cache is not enabled. Unable to cache: ' + text);
            return;
        }

        // Extract language from "en;volume;Text to say"
        if (text.indexOf(';') !== -1) {
            const arr = text.split(';', 3);
            // If language;text or volume;text
            if (arr.length === 2) {
                // If number
                if (parseInt(arr[0]).toString() !== arr[0]) {
                    language = arr[0];
                }
                text = arr[1];
            } else if (arr.length === 3) {
                // If language;volume;text or volume;language;text
                // If number
                if (parseInt(arr[0]).toString() === arr[0]) {
                    language = arr[1];
                } else {
                    language = arr[0];
                }
                text = arr[2];
            }
        }
        // if no text => do not process
        if (!text.length) {
            return;
        }

        // Check: may be it is file from DB filesystem, like /vis.0/main/img/door-bell.mp3
        if (text[0] === '/') {
            adapter.log.warn('mp3 file must not be cached: ' + text);
            return;
        }

        let isGenerate = false;
        if (!language) language = adapter.config.engine;

        // find out if say.mp3 must be generated
        if (!speech2device.sayItIsPlayFile(text)) isGenerate = sayitOptions[adapter.config.type].mp3Required;

        if (!isGenerate) {
            if (speech2device.sayItIsPlayFile(text)) {
                adapter.log.warn('mp3 file must not be cached: ' + text);
            } else {
                adapter.log.warn('Cache does not required for this engine: ' + adapter.config.engine);
            }
            return;
        }

        const md5filename = libs.path.join(options.cacheDir, libs.crypto.createHash('md5').update(language + ';' + text).digest('hex') + '.mp3');
        libs.fs = libs.fs || require('fs');

        if (libs.fs.existsSync(md5filename)) {
            adapter.log.debug('Text is yet cached: ' + text);
            return;
        }

        if (cacheRunning) {
            cacheFiles.push({text: text, language: language});
            return;
        }
    }

    cacheRunning = true;

    text2speech.sayItGetSpeech(text, language, false, (error, md5filename, _language, volume, seconds) => {
        if (error) {
            adapter.log.error('Cannot cache text: "' + error);
        } else {
            adapter.log.debug('Text is cached: "' + text + '" under ' + md5filename);
        }
        setTimeout(function () {
            cacheIt(true);
        }, 2000);
    });
}

function sayIt(text, language, volume, process) {
    let md5filename;
	let device = '';

    // Extract language from "en;volume;Text to say"
    if (text.indexOf(';') !== -1) {
        const arr = text.split(';', 3);
        // If language;text or volume;text
        if (arr.length === 2) {
            // If number
            if (parseInt(arr[0]).toString() === arr[0].toString()) {
                volume = arr[0];
            } else {
                device = arr[0];
            }
            text = arr[1];
        } else if (arr.length === 3) {
            // If language;volume;text or volume;language;text
            // If number
            if (parseInt(arr[0]).toString() === arr[0].toString()) {
                volume   = arr[0];
                device = arr[1];
            } else {
                volume   = arr[1];
                device = arr[0];
            }
            text = arr[2];
        }
    }

    // if no text => do not process
    if (!text.length) {
        sayFinished(0);
        return;
    }

	adapter.log.info(text);
	
    // Check: may be it is file from DB filesystem, like /vis.0/main/img/door-bell.mp3
    if (text[0] === '/') {
        let cached = false;
        if (adapter.config.cache) {
			adapter.log.info('Using cache');
            md5filename = libs.path.join(options.cacheDir, libs.crypto.createHash('md5').update(text).digest('hex') + '.mp3');

            if (libs.fs.existsSync(md5filename)) {
				adapter.log.info('File found in cache!');
                cached = true;
                text = md5filename;
            }
        }
        if (!cached) {
            const parts = text.split('/');
            const adap = parts[0];
            parts.splice(0, 1);
            const _path = parts.join('/');

            adapter.readFile(adap, _path, (err, data) => {
                if (data) {
                    try {
                        // Cache the file
                        if (md5filename) libs.fs.writeFileSync(md5filename, data);
                        libs.fs.writeFileSync(MP3FILE, data);
                        sayIt(MP3FILE, language, volume, process);
                    } catch (e) {
                        adapter.log.error('Cannot write file "' + MP3FILE + '": ' + e.toString());
                        sayFinished(0);
                    }
                } else {
                    // may be file from real FS
                    if (libs.fs.existsSync(text)) {
                        try {
                            data = libs.fs.readFileSync(text);
                        } catch (e) {
                            adapter.log.error('Cannot read file "' + text + '": ' + e.toString());
                            sayFinished(0);
                        }
                        // Cache the file
                        if (md5filename) libs.fs.writeFileSync(md5filename, data);
                        libs.fs.writeFileSync(MP3FILE, data);
                        sayIt(MP3FILE, language, volume, process);
                    } else {
                        adapter.log.warn('File "' + text + '" not found');
                        sayFinished(0);
                    }
                }
            });
            return;
        }
    } else {
        if (adapter.config.cache) {
			adapter.log.info('Using cache');
			const md5filename = libs.path.join(options.cacheDir, libs.crypto.createHash('md5').update(adapter.config.engine + ';' + text).digest('hex') + '.mp3');
			adapter.log.info('Searching for file in cache: ' + md5filename);
            if (libs.fs.existsSync(md5filename)) {
				adapter.log.info('File found in cache!');
                text = md5filename;
            }
        }
	}

    if (!process) {
        const time = Date.now();

        // Workaround for double text
        if (list.length > 1 && (list[list.length - 1].text === text) && (time - list[list.length - 1].time < 500)) {
            adapter.log.warn('Same text in less than half a second.. Strange. Ignore it.');
            return;
        }
        // If more time than 15 seconds
        if (adapter.config.announce && !list.length && (!lastSay || (time - lastSay > adapter.config.annoTimeout * 1000))) {
            // place as first the announce mp3
            list.push({text: adapter.config.announce, device: device, language: language, volume: (volume || adapter.config.volume) / 2, time: time});
            // and then text
            list.push({text: text, language: language, device: device, volume: (volume || adapter.config.volume), time: time});
            text = adapter.config.announce;
            volume = Math.round((volume || adapter.config.volume) / 100 * adapter.config.annoVolume);
        } else {
            list.push({text: text, language: language, device: device, volume: (volume || adapter.config.volume), time: time});
            if (list.length > 1) return;
        }
    }

    adapter.log.info('saying: ' + text);

    let isGenerate = false;
    if (!language) {
        language = adapter.config.engine;
    }
    if (!volume && adapter.config.volume)   volume = adapter.config.volume;

    // find out if say.mp3 must be generated
    if (!speech2device.sayItIsPlayFile(text)) {
        isGenerate = sayitOptions[adapter.config.type].mp3Required;
    }

    const speechFunction = speech2device.getFunction(adapter.config.type);

    // If text first must be generated
    if (isGenerate && sayLastGeneratedText !== '[' + language + ']' + text) {
        sayLastGeneratedText = '[' + language + ']' + text;
        text2speech.sayItGetSpeech(text, language, volume, (error, text, language, volume, duration) => {
            speechFunction(error, text, device, language, volume, duration, sayFinished);
        });
    } else {
        if (speech2device.sayItIsPlayFile(text)) {
            text2speech.getLength(text, (error, duration) => {
                speechFunction(error, text, device, language, volume, duration, sayFinished);
            });
        } else {
            if (!isGenerate) {
                speechFunction(null, text, device, language, volume, 0, sayFinished);
            } else if (adapter.config.cache) {
                md5filename = libs.path.join(options.cacheDir, libs.crypto.createHash('md5').update(language + ';' + text).digest('hex') + '.mp3');
                if (libs.fs.existsSync(md5filename)) {
                    text2speech.getLength(md5filename, (error, duration) => {
                        speechFunction(error, md5filename, language, volume, duration, sayFinished);
                    });
                } else {
                    sayLastGeneratedText = '[' + language + ']' + text;
                    text2speech.sayItGetSpeech(text, language, volume, (error, text, language, volume, duration) => {
                        speechFunction(error, text, device, language, volume, duration, sayFinished);
                    });
                }
            } else {
                text2speech.getLength(MP3FILE, (error, duration) => {
                    speechFunction(error, text, device, language, volume, duration, sayFinished);
                });
            }
        }
    }
}

function uploadFile(file, callback) {
    try {
        const stat = libs.fs.statSync(libs.path.join(__dirname + '/mp3/', file));
        if (!stat.isFile()) {
            // ignore not a file
            if (callback) callback();
            return;
        }
    } catch (e) {
        // ignore not a file
        if (callback) callback();
        return;
    }


    adapter.readFile(adapter.namespace, 'tts.userfiles/' + file, (err, data) => {
        if (err || !data) {
            try {
                adapter.writeFile(adapter.namespace, 'tts.userfiles/' + file, libs.fs.readFileSync(libs.path.join(__dirname + '/mp3/', file)), () => {
                    if (callback) callback();
                });
            } catch (e) {
                adapter.log.error('Cannot read file "' + __dirname + '/mp3/' + file + '": ' + e.toString());
                if (callback) callback();
            }
        } else {
            if (callback) callback();
        }
    });
}

function _uploadFiles(files, callback) {
    if (!files || !files.length) {
        adapter.log.info('All files uploaded');
        if (callback) callback();
        return;
    }

    uploadFile(files.pop(), () => setTimeout(_uploadFiles, 0, files, callback));
}
function uploadFiles(callback) {
    if (libs.fs.existsSync(__dirname + '/mp3')) {
        adapter.log.info('Upload announce mp3 files');
        _uploadFiles(libs.fs.readdirSync(__dirname + '/mp3'), callback);
    } else if (callback) {
        callback();
    }
}

function start() {
    if (adapter.config.announce) {
        adapter.config.annoDuration = parseInt(adapter.config.annoDuration) || 0;
        adapter.config.annoTimeout  = parseInt(adapter.config.annoTimeout)  || 15;
        adapter.config.annoVolume   = parseInt(adapter.config.annoVolume)   || 70; // percent from actual volume

        if (!libs.fs.existsSync(libs.path.join(__dirname, adapter.config.announce))) {
            adapter.readFile(adapter.namespace, 'tts.userfiles/' + adapter.config.announce, (err, data) => {
                if (data) {
                    try {
                        libs.fs.writeFileSync(libs.path.join(__dirname, adapter.config.announce), data);
                        adapter.config.announce = libs.path.join(__dirname, adapter.config.announce);
                    } catch (e) {
                        adapter.log.error('Cannot write file: ' + e.toString());
                        adapter.config.announce = '';
                    }
                }
            });
        } else {
            adapter.config.announce = __dirname + '/' + adapter.config.announce;
        }
    }

    // If cache enabled
    if (adapter.config.cache) {
        if (adapter.config.cacheDir && (adapter.config.cacheDir[0] === '/' || adapter.config.cacheDir[0] === '\\')) {
            adapter.config.cacheDir = adapter.config.cacheDir.substring(1);
        }
        options.cacheDir = libs.path.join(__dirname, adapter.config.cacheDir);
        if (options.cacheDir) {
            options.cacheDir = options.cacheDir.replace(/\\/g, '/');
            if (options.cacheDir[options.cacheDir.length - 1] === '/') {
                options.cacheDir = options.cacheDir.substring(0, options.cacheDir.length - 1);
            }
        } else {
            options.cacheDir = '';
        }

        const parts = options.cacheDir.split('/');
        let i = 0;
        while (i < parts.length) {
            if (parts[i] === '..') {
                parts.splice(i - 1, 2);
                i--;
            } else {
                i++;
            }
        }
        options.cacheDir = parts.join('/');
        // Create cache dir if does not exist
        if (!libs.fs.existsSync(options.cacheDir)) {
            try {
                mkpathSync(__dirname + '/', adapter.config.cacheDir);
            } catch (e) {
                adapter.log.error('Cannot create "' + options.cacheDir + '": ' + e.message);
            }
        } else {
            let engine = '';
            // Read the old engine
            if (libs.fs.existsSync(libs.path.join(options.cacheDir, 'engine.txt'))) {
                try {
                    engine = libs.fs.readFileSync(libs.path.join(options.cacheDir, 'engine.txt')).toString();
                } catch (e) {
                    adapter.log.error('Cannot read file "' + libs.path.join(options.cacheDir, 'engine.txt') + ': ' + e.toString());
                }
            }
            // If engine changed
            if (engine !== adapter.config.engine) {
                // Delete all files in this directory
                const files = libs.fs.readdirSync(options.cacheDir);
                for (let f = 0; f < files.length; f++) {
                    if (files[f] === 'engine.txt') continue;
                    if (libs.fs.existsSync(libs.path.join(options.cacheDir, files[f])) && libs.fs.lstatSync(libs.path.join(options.cacheDir, files[f])).isDirectory()) {
                        libs.fs.unlinkSync(libs.path.join(options.cacheDir, files[f]));
                    }
                }
                try {
                    libs.fs.writeFileSync(libs.path.join(options.cacheDir, 'engine.txt'), adapter.config.engine);
                } catch (e) {
                    adapter.log.error('Cannot write file "' + libs.path.join(options.cacheDir, 'engine.txt') + ': ' + e.toString());
                }
            }
        }
    }

    // Load libs
    for (let j = 0; j < sayitOptions[adapter.config.type].libs.length; j++) {
        libs[sayitOptions[adapter.config.type].libs[j]] = require(sayitOptions[adapter.config.type].libs[j]);
    }

    adapter.getState('tts.text', (err, state) => {
        if (err || !state) {
            adapter.setState('tts.text', '', true);
        }
    });

    adapter.getState('tts.volume', (err, state) => {
        if (err || !state) {
            adapter.setState('tts.volume', 70, true);
            if (adapter.config.type !== 'system') options.sayLastVolume = 70;
        } else {
            if (adapter.config.type !== 'system') options.sayLastVolume = state.val;
        }
    });

    adapter.getState('tts.playing', (err, state) => {
        if (err || !state) {
            adapter.setState('tts.playing', false, true);
        }
    });

    if (adapter.config.type === 'system') {
        // Read volume
        adapter.getState('tts.volume', (err, state) => {
            if (!err && state) {
                speech2device.sayItSystemVolume(state.val);
            } else {
                speech2device.sayItSystemVolume(70);
            }
        });
    }

    // calculate weblink for devices that require it
    if ((adapter.config.type === 'sonos') ||
        (adapter.config.type === 'chromecast') ||
        (adapter.config.type === 'mpd') ||
        (adapter.config.type === 'googleHome')) {

        adapter.getForeignObject('system.adapter.' + adapter.config.web, (err, obj) => {
            if (!err && obj && obj.native) {
                options.webLink = 'http';
                if (obj.native.auth) {
                    adapter.log.error('Cannot use server "' + adapter.config.web + '" with authentication for sonos/chromecast. Select other or create another one.');
                } else {
                    if (obj.native.secure) options.webLink += 's';
                    options.webLink += '://';
                    if (obj.native.bind === 'localhost' || obj.native.bind === '127.0.0.1') {
                        adapter.log.error('Selected web server "' + adapter.config.web + '" is only on local device available. Select other or create another one.');
                    } else {
                        if (obj.native.bind === '0.0.0.0') {
                            options.webLink += adapter.config.webServer;
                        } else {
                            options.webLink += obj.native.bind;
                        }
                    }

                    options.webLink += ':' + obj.native.port;
                }
            } else {
                adapter.log.error('Cannot read information about "' + adapter.config.web + '". No web server is active');
            }
        });
    }

    adapter.subscribeStates('*');
}

function main() {
    libs.fs   = require('fs');
    libs.path = require('path');

    if ((process.argv && process.argv.indexOf('--install') !== -1) ||
        ((!process.argv || process.argv.indexOf('--force') === -1) && (!adapter.common || !adapter.common.enabled))) {
        adapter.log.info('Install process. Upload files and stop.');
        // Check if files exists in datastorage
        uploadFiles(() => adapter.stop ? adapter.stop() : process.exit());
    } else {
        // Check if files exists in datastorage
        uploadFiles(start);
    }
}
