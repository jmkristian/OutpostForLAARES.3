/* Copyright 2018 by John Kristian

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
const child_process = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const querystring = require('querystring');
const SSI = require('node-ssi');
const Transform = require('stream').Transform;

const ENCODING = 'utf-8';
const NOT_FOUND = 404;
const OpdFAIL = 'OpdFAIL';
const MsgFolderName = path.resolve('pack-it-forms', 'msgs');
const PortFileName = path.resolve('bin', 'port.txt');

switch(process.argv[2]) {
case 'install':
    install();
    break;
case 'uninstall':
    uninstall();
    break;
case 'serve':
    serve();
    break;
case 'new':
case 'draft':
case 'ready':
case 'sent':
case 'unread':
case 'read':
    openMessage();
    break;
default:
    console.log(process.argv[1] + ': unknown verb "' + process.argv[2] + '"');
}

function install() {
    // This method must be idempotent, in part because Avira antivirus
    // might execute it repeatedly while scrutinizing the .exe for viruses.
    var myDirectory = process.cwd();
    fs.readFile('LOSF.ini', ENCODING, function(err, data) {
        if (err) throw err;
        var newData = data.replace(/\{\{INSTDIR\}\}/gi, myDirectory);
        if (newData != data) {
            fs.writeFile('LOSF.ini', newData, {encoding: ENCODING}, function(err) {
                if (err) throw err; // intolerable
            });
        }
    });
    // Each of the arguments names a directory that contains Outpost configuration data.
    // Upsert an INCLUDE into the Launch.local file in each of those directories:
    var myLaunch = path.resolve(myDirectory, 'LOSF.launch');
    var target = new RegExp('^INCLUDE\\s+' + enquoteRegex(myLaunch) + '$', 'i');
    for (var a = 3; a < process.argv.length; a++) {
        var outpostLaunch = path.resolve(process.argv[a], 'Launch.local');
        if (!fs.existsSync(outpostLaunch)) {
            fs.writeFile(outpostLaunch, myLaunch, {encoding: ENCODING}, function(err) {
                if (err) console.log(err);  // tolerable
            }); 
        } else {
            fs.readFile(outpostLaunch, ENCODING, function(err, data) {
                if (err) {
                    console.log(err); // tolerable
                } else {
                    var lines = data.split(/[\r\n]+/);
                    for (var i in lines) {
                        if (target.test(lines[i])) {
                            // The right INCLUDE is already in outpostLaunch.
                            // Perhaps this installer was executed repeatedly.
                            return; // don't modify outpostLaunch
                        }
                    }
                    var myInclude = 'INCLUDE ' + myLaunch + '\r\n';
                    if (data && !(/[\r\n]+$/.test(data))) {
                        // The outpostLaunch file doesn't end with a newline.
                        myInclude = '\r\n' + myInclude;
                    }
                    fs.appendFile(outpostLaunch, myInclude, {encoding: ENCODING}, function(err) {
                        if (err) console.log(err);  // tolerable
                    });
                }
            });
        }
    }
}

function uninstall() {
    var myLaunch = enquoteRegex(path.resolve(process.cwd(), 'LOSF.launch'));
    for (a = 3; a < process.argv.length; a++) {
        var outpostLaunch = path.resolve(process.argv[a], 'Launch.local');
        if (fs.existsSync(outpostLaunch)) {
            fs.readFile(outpostLaunch, ENCODING, function(err, data) {
                if (err) {
                    console.log(err);
                } else {
                    var myInclude = new RegExp('^INCLUDE\s+' + myLaunch + '[\r\n]+', 'i');
                    var newData = data.replace(myInclude, "");
                    myInclude = new RegExp('[\r\n]+INCLUDE\s+' + myLaunch + '[\r\n]+', 'gi');
                    newData = newData.replace(myInclude, "\r\n");
                    if (newData != data) {
                        fs.writeFile(outpostLaunch, newData, {encoding: ENCODING}, function(err) {
                            if (err) console.log(err);
                        });
                    }
                }
            });
        }
    }
}

function openMessage() {
    var argv = [];
    for (var i = 2; i < process.argv.length; i++) {
        argv.push(process.argv[i]);
    }
    if (fs.existsSync(PortFileName)) {
        openForm(0, argv);
    } else {
        // There's definitely no server running. Start one now:
        startServer(function() {setTimeout(openForm, 500, 0, argv);});
    }
}

function openForm(retry, argv) {
    try {
        var options = {host: '127.0.0.1',
                       port: parseInt(fs.readFileSync(PortFileName, ENCODING)),
                       method: 'POST',
                       path: '/open',
                       headers: {'Content-Type': 'text/json'}};
        var req = http.request(options, function(res) {
            res.setEncoding(ENCODING);
            var data = '';
            res.on('data', function(chunk) {
                data += chunk;
            });
            res.on('end', function() {
                startBrowserAndExit(options.port, '/form-' + data);
            });
        });
        req.on('error', function(err) {
            openFormFailed(err, retry, argv);
        });
        req.write(JSON.stringify(argv));
        req.end();
    } catch(err) {
        openFormFailed(err, retry, argv);
    }
}

function openFormFailed(err, retry, argv) {
    console.log(err);
    if (retry >= 4) {
        console.error(retry + ' attempts failed ' + JSON.stringify(argv));
    } else {
        if (retry == 1) {
            startServer(); // in case the old server died or stalled
        }
        retry++;
        setTimeout(openForm, retry * 1000, retry, argv);
    }
}

function startServer(andThen) {
    const command = 'start "Outpost for LAARES" /MIN bin\\launch.exe serve';
    console.log(command);
    child_process.exec(
        command,
        {windowsHide: true},
        function(err, stdout, stderr) {
            if (err) {
                console.error(err);
                console.error(stdout.toString(ENCODING) + stderr.toString(ENCODING));
            }
            if (andThen) {
                andThen();
            }
        });
}

function startBrowserAndExit(port, path) {
    const command = 'start "Open a Form" /B http://127.0.0.1:' + port + path;
    console.log(command);
    child_process.exec(
        command,
        function(err, stdout, stderr) {
            if (err) {
                console.error(err);
            }
            console.log(stdout.toString(ENCODING) + stderr.toString(ENCODING));
            process.exit(0);
        });
}

var openForms = {'0': {quietSeconds: 0}}; // all the forms that are currently open
// Form 0 is a hack to make sure the server doesn't shut down immediately after starting.
var nextFormId = 1; // Forms are assigned sequence numbers when they're opened.

function serve() {
    console.log("Let this program run in the background. There's no need to interact with it.");
    console.log('It works with your browser to show forms and submit messages to Outpost.');
    console.log('It will run as long as you have forms open, and stop a few minutes later.');
    const server = http.createServer(onRequest);
    server.listen(0);
    const address = server.address();
    fs.writeFileSync(PortFileName, address.port + '', {encoding: ENCODING}); // advertise my port
    process.stdout.write = writeTo(path.resolve('bin', 'logs', 'server_' + address.port + '.log'));
    console.log('Listening for HTTP requests on port ' + address.port + '...');
    const checkSilent = setInterval(function() {
        // Scan openForms and close any that have been quiet too long.
        var anyOpen = false;
        for (formId in openForms) {
            var form = openForms[formId];
            if (form) {
                form.quietSeconds += 5;
                // The client is expected to GET /ping-formId every 30 seconds.
                if (form.quietSeconds >= 120) {
                    closeForm(formId);
                } else {
                    anyOpen = true;
                }
            }
        }
        if (!anyOpen) {
            console.log("forms are all closed");
            clearInterval(checkSilent);
            server.close();
            // Give someone a chance to read that last message before the window disappears:
            setTimeout(process.exit, 2000, 0);
        }
    }, 5000);
}

function writeTo(fileName) {
    if (!fs.existsSync(path.dirname(fileName))) {
        fs.mkdirSync(path.dirname(fileName));
    }
    const fileStream = fs.createWriteStream(fileName, {autoClose: true});
    const windowsEOL = new Transform({
        // Transform line endings from Unix style to Windows style.
        transform: function(chunk, encoding, callback) {
            if (encoding == 'buffer') {
                callback(null, chunk.toString('binary').replace(/([^\r])\n/g, '$1\r\n'));
            } else {
                callback(null, chunk); // no change
            }
        }
    });
    windowsEOL.pipe(fileStream);
    console.log('Detailed information about its activity can be seen in');
    console.log(fileName);
    return windowsEOL.write.bind(windowsEOL);
}

function closeForm(formId) {
    var form = openForms[formId];
    if (form) {
        console.log('form ' + formId + ' closed');
        if (form.msgFileName) {
            fs.unlinkSync(form.msgFileName);
        }
    }
    delete openForms[formId];
}

/** Handle an HTTP request. */
function onRequest(req, res) {
    const reqMethod = req.method.toLowerCase();
    const reqSummary = req.method + ' ' + req.url;
    function respond(err, data) {
        if (err) {
            if (typeof err == 'number') {
                res.statusCode = err;
                res.statusMessage = data ? ('' + data) : http.STATUS_CODES[err];
            } else {
                res.statusCode = 500;
                res.statusMessage = '' + err;
            }
        } else if (data) {
            res.write(data, ENCODING);
        }
        console.log(reqSummary + ' ' + res.statusCode + ' ' + res.statusMessage);
        res.end();
    }
    try {
        if (reqMethod == 'get') {
            onGet(req.url, res, respond);
        } else if (reqMethod == 'post') {
            onPost(req, res, respond);
        } else {
            respond(501, http.STATUS_CODES[501] + ' ' + req.method + ' ' + req.url);
        }
    } catch(err) {
        respond(err);
    }
}

/** Handle an HTTP GET request. */
function onGet(url, res, respond) {
    getFile = url && url.startsWith('/') && url.substring(1);
    if (getFile && getFile.startsWith('resources/')) {
        fs.readFile(path.resolve('pack-it-forms', getFile), ENCODING, respond);
    } else if (getFile && getFile.startsWith('form-')) {
        res.setHeader('Content-Type', 'text/html; charset=' + ENCODING);
        onGetForm(getFile.substring(5), respond);
    } else {
        respond(NOT_FOUND);
        if (getFile && getFile.startsWith('ping-')) {
            keepAlive(getFile.substring(5));
        }
    }
}

/** Handle an HTTP GET /form-id request. */
function onGetForm(formId, respond) {
    var form = openForms[formId];
    if (!form) {
        console.log('form ' + formId + ' is not open');
        respond(NOT_FOUND);
        return;
    }
    keepAlive(formId);
    var environment = {message_status: form.argv[0],
                       pingURL: '/ping-' + formId,
                       submitURL: '/submit-' + formId};
    for (var i = 1; i + 1 < form.argv.length; i = i + 2) {
        environment[form.argv[i]] = form.argv[i+1];
    }
    if (environment.msgno == '-1') { // a sentinel value
        delete environment.msgno;
    }
    if (environment.MSG_FILENAME) {
        var msgFileName = path.resolve(MsgFolderName, environment.MSG_FILENAME);
        environment.message = fs.readFileSync(msgFileName, ENCODING);
        form.msgFileName = msgFileName;
        if (!environment.msgno && isMyDraftMessage(environment.message_status)) {
            // The MsgNo field is set by the sender. For a draft message, the sender is me.
            // So pass it to the form as environment.message, shown as "My Message Number".
            var found = /[\r\n]\s*MsgNo:\s*\[([^\]]*)\]/.exec(environment.message);
            if (found) {
                environment.msgno = found[1];
            }
        }
        if (!environment.filename) {
            found = /[\r\n]# *FORMFILENAME:([^\r\n]*)[\r\n]/.exec(environment.message);
            if (found) {
                environment.filename = found[1].trim();
            }
        }
    }
    if (!environment.filename) {
        throw new Error('form file name is ' + environment.filename);
    }
    var formFileName = path.resolve('pack-it-forms', environment.filename);
    if (!fs.existsSync(formFileName)) {
        throw new Error('no form file ' + formFileName);
    }
    console.log('form ' + formId + ' viewed');
    console.log(environment);
    new SSI({
        baseDir: 'pack-it-forms',
        encoding: ENCODING,
        payload: {environment: encodeHTML(JSON.stringify(environment))}
    }).compileFile(formFileName, respond);
}

function isMyDraftMessage(status) {
    return status == 'new' || status == 'draft' || status == 'ready';
}

/** Handle an HTTP POST request. */
function onPost(req, res, respond) {
    if (req.url == '/open') {
        res.setHeader('Content-Type', 'text/plain; charset=' + ENCODING);
        var data = '';
        req.on('data', function(chunk) {
            data += chunk;
        });
        req.on('end', function() {
            var formId = '' + nextFormId++;
            openForms[formId] = {
                quietSeconds: 0,
                argv: JSON.parse(data)
            };
            console.log('form ' + formId + ' opened ' + data);
            respond(null, formId);
        });
    } else if (req.url.startsWith('/submit-')) {
        const formId = req.url.substring(8);
        res.setHeader('Content-Type', 'text/html; charset=' + ENCODING);
        var data = '';
        req.on('data', function(chunk) {
            data += chunk;
        });
        req.on('end', function() {
            onSubmit(formId, data, respond);
        });
    } else {
        respond(NOT_FOUND);
    }
}

function onSubmit(formId, data, respond) {
    keepAlive(formId);
    var formtext = querystring.parse(data).formtext;
    var found = /^# ([^\r\n]*)[\r\n]/.exec(formtext);
    var subject = found ? found[1] : '';
    var msgFileName = path.resolve(MsgFolderName,
                                   (subject || '_toOutpost').replace(/[\/\\]/g, '~') + '.txt');
    function showError(text) {
        respond(null, '<HTML><body>A problem occurred:<pre>\r\n'
                + encodeHTML(text)
                + '</pre></body></HTML>');
    }
    fs.writeFile(msgFileName, formtext, {encoding: ENCODING}, function(err) {
        if (err) {
            showError(msgFileName + ' ' + err);
        } else {
            try {
                fs.unlinkSync(OpdFAIL);
            } catch(e) {
                // ignored
            }
            child_process.execFile(
                'bin\\Aoclient.exe',
                ['-a', 'LOSF', '-f', msgFileName, '-s', subject],
                function(err, stdout, stderr) {
                    if (err) {
                        showError(err + '\r\nwhile submitting:\r\n' + formtext);
                    } else if (fs.existsSync(OpdFAIL)) {
                        // This is described in the Outpost Add-on Implementation Guide version 1.2,
                        // but Aoclient.exe doesn't appear to implement it.
                        // Happily, it does pop up a window to explain what went wrong.
                        showError(OpdFAIL + ': ' + fs.readFileSync(OpdFAIL, ENCODING));
                    } else {
                        respond(null, sentMessage('Subject: ' + subject + '\r\n' + formtext,
                                                  stdout, stderr));
                        console.log('form ' + formId + ' submitted');
                        fs.unlinkSync(msgFileName);
                        // Don't closeForm yet, in case the operator goes back and submits it again.
                    }
                });
        }
    });
}

function sentMessage(formtext, stdout, stderr) {
    return '<HTML><body>'
        + 'OK, your message has been submitted to Outpost. You can close this page.'
        + '<pre>'
        + encodeHTML(stdout.toString(ENCODING) + stderr.toString(ENCODING))
        + '</pre>'
    // Sadly, this doesn't work on modern browsers:
        + '<script type="text/javascript">setTimeout(function(){window.open("","_self").close();},5000);</script>'
        + '</body></HTML>';
}

function keepAlive(formId) {
    form = openForms[formId];
    if (form) {
        form.quietSeconds = 0;
    }
}

function encodeHTML(text) {
    // Crude but adequate:
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function enquoteRegex(text) {
    // Crude but adequate:
    return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}
