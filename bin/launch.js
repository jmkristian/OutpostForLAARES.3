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
/*
  This is a Node.js program which serves several purposes:
  - Edit configuration files during installation
  - Undo those edits during uninstallation
  - Receive a message from Outpost
  - Construct an HTML form representing a message
  - Show the form to an operator
  - Submit a message to Outpost

  Any single execution does just one of those things,
  depending on the value of process.argv[2].
  For example, "node bin/launch.js install C:/Outpost"
  edits C:/Outpost/Launch.local and configuration files
  in the current working directory.

  When an operator clicks a menu item to create a message
  or opens an existing message that belongs to this add-on,
  a fairly complex sequence of events ensues.
  - Outpost executes this program with arguments specified in ../*.ini.
  - This program POSTs the arguments to a server, and then
  - launches a browser, which GETs an HTML form from the server.
  - When the operator clicks "Submit", the browser POSTs a message to the server,
  - and the server runs bin/Aoclient.exe, which submits the message to Outpost.

  The server is a process running this program with a single argument "serve".
  The server is started as a side-effect of creating or opening a message.
  When this program tries and fails to POST arguments to the server,
  it tries to start the server, delays a bit and retries the POST.
  The server continues to run as long as any of the forms it serves are open,
  plus a couple minutes. To implement this, the browser pings the server
  periodically, and the server notices when the pings stop.

  It's kind of weird to implement all of this behavior in a single program.
  Splitting it into several programs would have drawbacks:
  - It would be packaged into several frozen binaries, which would bloat the
    installer, since each binary contains the enire Node.js runtime code.
  - Antivirus and firewall software would have to scrutinize multiple programs,
    which is annoying to the developers who have to persuade Symantec to bless
    them and operators who have to wait for Avast to scan them.

  To address the issue of operators waiting for antivirus scan, the
  installation script runs "launch.exe dry-run", which runs this program
  as though it were handling a message, but doesn't launch a browser.
*/
const bodyParser = require('body-parser');
const child_process = require('child_process');
const concat_stream = require('concat-stream');
const express = require('express');
const fs = require('fs');
const http = require('http');
const morgan = require('morgan');
const path = require('path');
const querystring = require('querystring');
const Transform = require('stream').Transform;

const ENCODING = 'utf-8'; // for reading from files
const CHARSET = ENCODING; // for HTTP
const JSON_TYPE = 'application/json';
const NOT_FOUND = 404;
const OpdFAIL = path.join('bin', 'OpdFAIL');
const PackItForms = 'pack-it-forms';
const PackItMsgs = path.join(PackItForms, 'msgs');
const PortFileName = path.join('bin', 'server-port.txt');
const LogFileAgeLimitMs = 1000 * 60 * 60 * 24; // 24 hours
const IconStyle = 'width:24pt;height:24pt;vertical-align:middle;';

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
case 'dry-run':
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
    const myDirectory = process.cwd();
    fs.readFile('Los_Altos.ini', ENCODING, function(err, data) {
        if (err) throw err;
        var newData = expandVariables(data, {INSTDIR: myDirectory});
        if (newData != data) {
            fs.writeFile('Los_Altos.ini', newData, {encoding: ENCODING}, function(err) {
                if (err) throw err; // intolerable
            });
        }
    });
    // Each of the arguments names a directory that contains Outpost configuration data.
    // Upsert an INCLUDE into the Launch.local file in each of those directories:
    const myLaunch = path.resolve(myDirectory, 'Los_Altos.launch');
    const myInclude = 'INCLUDE ' + myLaunch + '\r\n';
    const target = new RegExp('^INCLUDE\\s+' + enquoteRegex(myLaunch) + '$', 'i');
    for (var a = 3; a < process.argv.length; a++) {
        var outpostLaunch = path.resolve(process.argv[a], 'Launch.local');
        if (!fs.existsSync(outpostLaunch)) {
            fs.writeFile(outpostLaunch, myInclude, {encoding: ENCODING}, function(err) {
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
    const myLaunch = enquoteRegex(path.resolve(process.cwd(), 'Los_Altos.launch'));
    const myInclude1 = new RegExp('^INCLUDE\\s+' + myLaunch + '[\r\n]*', 'i');
    const myInclude = new RegExp('[\r\n]+INCLUDE\\s+' + myLaunch + '[\r\n]+', 'gi');
    for (a = 3; a < process.argv.length; a++) {
        var outpostLaunch = path.resolve(process.argv[a], 'Launch.local');
        if (fs.existsSync(outpostLaunch)) {
           fs.readFile(outpostLaunch, ENCODING, function(err, data) {
                if (err) {
                    console.log(err);
                } else {
                    var newData = data.replace(myInclude1, '').replace(myInclude, "\r\n");
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
    var args = [];
    for (var i = 2; i < process.argv.length; i++) {
        args.push(process.argv[i]);
    }
    if (fs.existsSync(PortFileName)) {
        openForm(0, args);
    } else {
        // There's definitely no server running. Start one now:
        startServer(function() {setTimeout(openForm, 500, 0, args);});
    }
}

function openForm(retry, args) {
    try {
        var options = {host: '127.0.0.1',
                       port: parseInt(fs.readFileSync(PortFileName, ENCODING)),
                       method: 'POST',
                       path: '/open',
                       headers: {'Content-Type': JSON_TYPE + '; charset=' + CHARSET}};
        var req = http.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) {
                data += chunk.toString(CHARSET);
            });
            res.on('end', function() {
                data = data.trim();
                if (data) {
                    startBrowserAndExit(options.port, '/form-' + data);
                } else {
                    process.exit(0); // This was just a dry run.
                }
            });
        });
        req.on('error', function(err) {
            openFormFailed(err, retry, args);
        });
        req.end(JSON.stringify(args), CHARSET);
    } catch(err) {
        openFormFailed(err, retry, args);
    }
}

function openFormFailed(err, retry, args) {
    console.log(err);
    if (retry >= 4) {
        console.error(retry + ' attempts failed ' + JSON.stringify(args));
        setTimeout(console.log, 5000, 'Goodbye.');
    } else {
        if (retry == 0 || retry == 3) {
            startServer(); // in case the old server died or stalled
        }
        retry++;
        setTimeout(openForm, retry * 1000, retry, args);
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
    const app = express();
    app.set('etag', false); // convenient for troubleshooting
    app.use(morgan('tiny'));
    app.use(bodyParser.json({type: JSON_TYPE}));
    app.post('/open', function(req, res, next) {
        if (req.body && req.body[0] == 'dry-run') {
            res.end(); // with no body
            // This tells the client not to open a browser page.
        } else {
            const formId = '' + nextFormId++;
            onOpen(formId, req.body);
            res.set({'Content-Type': 'text/plain; charset=' + CHARSET});
            res.end(formId, CHARSET);
        }
    });
    app.get('/form-:formId', function(req, res, next) {
        keepAlive(req.params.formId);
        onGetForm(req.params.formId, res);
    });
    app.post('/submit-:formId', function(req, res, next) {
        keepAlive(req.params.formId);
        req.pipe(concat_stream(function(buffer) {
            onSubmit(req.params.formId, buffer, res);
        }));
    });
    app.get('/ping-:formId', function(req, res, next) {
        keepAlive(req.params.formId);
        res.statusCode = NOT_FOUND;
        res.end(); // with no body. The client ignores this response.
    });
    app.get('/msgs/:msgno', function(req, res, next) {
        // The client may not get the message this way,
        // since the server doesn't know what the formId is.
        // Instead, onGetForm includes JavaScript code
        // which passes the message to set_form_data_div.
        res.statusCode = NOT_FOUND;
        res.end(); // with no body
    });
    app.get(/^\/.*/, express.static(PackItForms));

    const server = app.listen(0);
    const address = server.address();
    fs.writeFileSync(PortFileName, address.port + '', {encoding: ENCODING}); // advertise my port
    deleteOldFiles(path.join('bin', 'logs'), /^server-\d*\.log$/, LogFileAgeLimitMs);
    process.stdout.write = writeToFile(path.resolve('bin', 'logs', 'server-' + address.port + '.log'));
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
            fs.readFile(PortFileName, {encoding: ENCODING}, function(err, data) {
                if (data.trim() == (address.port + '')) {
                    fs.unlink(PortFileName, function(err) {});
                }
                process.exit(0);
            });
        }
    }, 5000);
}

function onOpen(formId, args) {
    var form = {
        quietSeconds: 0,
        args: args,
    };
    form.environment = getEnvironment(form.args);
    form.environment.pingURL = '/ping-' + formId;
    form.environment.submitURL = '/submit-' + formId;
    openForms[formId] = form;
    console.log('form ' + formId + ' opened');
    console.log(form.environment);
}

function keepAlive(formId) {
    form = openForms[formId];
    if (form) {
        form.quietSeconds = 0;
    }
}

function closeForm(formId) {
    var form = openForms[formId];
    if (form) {
        console.log('form ' + formId + ' closed');
        if (form.environment && form.environment.MSG_FILENAME) {
            fs.unlink(form.environment.MSG_FILENAME, function(err) {});
        }
    }
    delete openForms[formId];
}

function getEnvironment(args) {
    var environment = {};
    if (args && args.length > 0) {
        environment.message_status  = args[0];
        for (var i = 1; i + 1 < args.length; i = i + 2) {
            environment[args[i]] = args[i+1];
        }
        if (environment.msgno == '-1') { // a sentinel value
            delete environment.msgno;
        }
    }
    return environment;
}

function getMessage(environment) {
    var message = null;
    if (environment.MSG_FILENAME) {
        var msgFileName = path.resolve(PackItMsgs, environment.MSG_FILENAME);
        message = fs.readFileSync(msgFileName, ENCODING);
        if (!environment.msgno && isMyDraftMessage(environment.message_status)) {
            // The MsgNo field is set by the sender. For a draft message, the sender is me.
            // So pass it to the form as environment.msgno, shown as "My Message Number".
            var found = /[\r\n]\s*MsgNo:\s*\[([^\]]*)\]/.exec(message);
            if (found) {
                environment.msgno = found[1];
            }
        }
        if (!environment.filename) {
            found = /[\r\n]#\s*FORMFILENAME:([^\r\n]*)[\r\n]/.exec(message);
            if (found) {
                environment.filename = found[1].trim();
            }
        }
    }
    return message;
}

function isMyDraftMessage(status) {
    return status == 'new' || status == 'draft' || status == 'ready';
}

/** Handle an HTTP GET /form-id request. */
function onGetForm(formId, res) {
    res.set({'Content-Type': 'text/html; charset=' + CHARSET});
    var form = openForms[formId];
    if (!form) {
        console.log('form ' + formId + ' is not open');
        res.sendStatus(NOT_FOUND);
    } else {
        console.log('form ' + formId + ' viewed');
        try {
            if (form.message == null) {
                form.message = getMessage(form.environment);
            }
            res.send(getFormHTML(form.environment, form.message));
        } catch(err) {
            res.send(errorToHTML(err));
        }
    }
}

function getFormHTML(environment, message) {
    if (!environment.filename) {
        throw new Error('form filename is ' + environment.filename);
    }
    var formFileName = path.join(PackItForms, environment.filename);
    var html = fs.readFileSync(formFileName, ENCODING);
    html = expandDataIncludes(html, environment, message);
    return html;
}

/* Expand data-include-html elements, for example:
  <div data-include-html="ics-header">
    {
      "5.": "PRIORITY",
      "9b.": "{{msgno|msgno2name}}"
    }
  </div>
*/
function expandDataIncludes(data, environment, message) {
    var oldData = data;
    while(true) {
        var newData = expandDataInclude(oldData, environment, message);
        if (newData == oldData) {
            return oldData;
        }
        oldData = newData; // and try it again, in case there are nested includes.
    }
}

function expandDataInclude(data, environment, message) {
    const target = /<\s*div\s+data-include-html\s*=\s*"[^"]*"\s*>[^<]*<\/\s*div\s*>/gi;
    return data.replace(target, function(found) {
        var matches = found.match(/"([^"]*)"\s*>([^<]*)/);
        var name = matches[1];
        var formDefaults = matches[2].trim();
        // Read a file from pack-it-forms:
        var fileName = path.join(PackItForms, 'resources', 'html', name + '.html')
        var result = fs.readFileSync(fileName, ENCODING);
        // Remove the enclosing <div></div>:
        result = result.replace(/^\s*<\s*div\s*>\s*(.*)/i, '$1');
        result = result.replace(/(.*)<\/\s*div\s*>\s*$/i, '$1');
        if (name == 'submit-buttons') {
            // Add some additional stuff:
            result += expandVariables(
                fs.readFileSync(path.join('bin', 'after-submit-buttons.html'), ENCODING),
                {message: JSON.stringify(message), queryDefaults: JSON.stringify(environment)});
        }
        if (formDefaults) {
            console.log(`default values: ${formDefaults}`);
            result += `<script type="text/javascript">
  var formDefaultValues;
  if (!formDefaultValues) {
      formDefaultValues = [];
  }
  formDefaultValues.push(${formDefaults});
</script>
`;
        }
        return result;
    });
}

function onSubmit(formId, buffer, res) {
    res.set({'Content-Type': 'text/html; charset=' + CHARSET});
    try {
        const q = querystring.parse(buffer.toString(CHARSET));
        var message = q.formtext;
        const foundSubject = /[\r\n]*![^!]*!\s*([^\r\n]*)[\r\n]/.exec(message);
        const subject = foundSubject ? foundSubject[1] : '';
        const formFileName = openForms[formId].environment.filename;
        const msgFileName = path.resolve(PackItMsgs, 'form-' + formId + '.txt');
        // Convert the message from PACF format to ADDON format:
        message = message.replace(/([\r\n]*)![^!]+![^\r\n]*[\r\n]*/, '$1');
        message = message.replace(/[\r\n]*#EOF/, '\r\n!/ADDON!');
        message = message.replace(/[\r\n]*(#\s*FORMFILENAME:\s*)[^\r\n]*[\r\n]*/,
                                  '\r\n$1' + formFileName.replace('$', '\\$') + '\r\n');
        fs.writeFile(msgFileName, message, {encoding: ENCODING}, function(err) {
            if (err) {
                res.send(errorToHTML(err));
            } else {
                try {
                    fs.unlinkSync(OpdFAIL);
                } catch(err) {
                    // ignored
                }
                console.log('form ' + formId + ' submitting');
                child_process.execFile(
                    path.join('bin', 'Aoclient.exe'),
                    ['-a', 'Los_Altos', '-f', msgFileName, '-s', subject],
                    function(err, stdout, stderr) {
                        try {
                            if (err) {
                                throw err;
                            } else if (fs.existsSync(OpdFAIL)) {
                                // This is described in the Outpost Add-on Implementation Guide version 1.2,
                                // but Aoclient.exe doesn't appear to implement it.
                                // Happily, it does pop up a window to explain what went wrong.
                                throw (OpdFAIL + ': ' + fs.readFileSync(OpdFAIL, ENCODING));
                            } else {
                                res.send(submittedMessage(stdout, stderr));
                                console.log('form ' + formId + ' submitted');
                                fs.unlinkSync(msgFileName);
                                // Don't closeForm, in case the operator goes back and submits it again.
                            }
                        } catch(err) {
                            res.send(errorToHTML(err));
                        }
                    });
            }
        });
    } catch(err) {
        res.send(errorToHTML(err));
    }
}

function submittedMessage(stdout, stderr) {
    const output = encodeHTML((stdout ? stdout.toString(ENCODING) : '') +
                              (stderr ? stderr.toString(ENCODING) : ''));
    return `<HTML><body>
  <img src="icon-check.png" alt="OK" style="${IconStyle}">
    &nbsp;&nbsp;The message has been submitted to Outpost. You can close this page.
    <pre>
${output}</pre>
  <script type="text/javascript">setTimeout(function(){window.open("","_self").close();},5000);</script>
</body></HTML>`;
}

function errorToHTML(err) {
    const message = encodeHTML((err && err.stack) ? err.stack : err);
    return `<HTML><body>
  <img src="icon-warning.png" alt="warning" style="${IconStyle}">
    &nbsp;&nbsp;Something went wrong:<pre>\r\n
${message}</pre>
</body></HTML>`;
}

function deleteOldFiles(directoryName, fileNamePattern, ageLimitMs) {
    const deadline = (new Date).getTime() - ageLimitMs;
    try {
        const fileNames = fs.readdirSync(directoryName, {encoding: ENCODING});
        for (var f in fileNames) {
            var fileName = fileNames[f];
            if (fileNamePattern.test(fileName)) {
                var fullName = path.join(directoryName, fileName);
                fs.stat(fullName, function(err, stats) {
                    if (err) {
                        console.log(err);
                    } else if (stats.isFile() && stats.mtimeMs < deadline) {
                        fs.unlink(fullName, function(err) {});
                    }
                });
            }
        }
    } catch(err) {
    }
}

function writeToFile(fileName) {
    if (!fs.existsSync(path.dirname(fileName))) {
        fs.mkdirSync(path.dirname(fileName));
    }
    const fileStream = fs.createWriteStream(fileName, {autoClose: true});
    const windowsEOL = new Transform({
        // Transform line endings from Unix style to Windows style.
        transform: function(chunk, encoding, output) {
            if (encoding == 'buffer') {
                output(null, new Buffer(chunk.toString('binary')
                                             .replace(/([^\r])\n/g, '$1\r\n'),
                                        'binary'));;
            } else if (typeof chunk == 'string') {
                output(null, chunk.replace(/([^\r])\n/g, '$1\r\n'));
            } else {
                output(null, chunk); // no change to an object
            }
        }
    });
    windowsEOL.pipe(fileStream);
    console.log('Detailed information about its activity can be seen in');
    console.log(fileName);
    return windowsEOL.write.bind(windowsEOL);
}

function expandVariables(data, values) {
    for (var v in values) {
        data = data.replace(new RegExp(enquoteRegex('{{' + v + '}}'), 'g'), values[v]);
    }
    return data;
}

function encodeHTML(text) {
    // Crude but adequate:
    return ('' + text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function enquoteRegex(text) {
    // Crude but adequate:
    return ('' + text).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}
