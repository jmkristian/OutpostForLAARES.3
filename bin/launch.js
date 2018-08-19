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
const concat_stream = require('concat-stream');
const express = require('express');
const fs = require('fs');
const http = require('http');
const morgan = require('morgan');
const path = require('path');

const ENCODING = 'utf-8';
const NOT_FOUND = 404;
const PackItForms = 'pack-it-forms';
const PackItMsgs = path.join(PackItForms, 'msgs');
const PortFileName = path.join('bin', 'port.txt');

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
        var newData = expandVariables(data, {INSTDIR: myDirectory});
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
    const app = express();
    app.set('etag', false); // convenient for debugging
    app.use(morgan('dev'));
    app.post('/open', function(req, res, next) {
        req.pipe(concat_stream(function(data) {
            var formId = '' + nextFormId++;
            openForms[formId] = {
                quietSeconds: 0,
                argv: JSON.parse(data)
            };
            console.log('form ' + formId + ' opened ' + data);
            res.send(formId);
        }));
    });
    app.get('/form-:formId', function(req, res, next) {
        res.set({'Content-Type': 'text/html; charset=' + ENCODING});
        res.send(onGetForm(req.params.formId, res));
    });
    app.get('/msgs/:msgno', function(req, res, next) {
        if (req.params.msgno != environment.msgno) {
            res.sendStatus(400); // may not read other messages
        } else {
            res.set({'Content-Type': 'text/plain; charset=' + ENCODING});
            res.send(environment.message ? environment.message : '');
            // The client will quietly ignore an empty message.
        }
    });
    app.get(/^\/.*/, express.static(PackItForms));
    const server = app.listen(0);
    const address = server.address();
    fs.writeFileSync(PortFileName, address.port + '', {encoding: ENCODING}); // advertise my port
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
            // setTimeout(process.exit, 2000, 0);
        }
    }, 5000);
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
        if (form.msgFileName) {
            fs.unlinkSync(form.msgFileName);
        }
    }
    delete openForms[formId];
}

function getEnvironment(args) {
    var environment = {message_status: args[2]};
    for (var i = 3; i + 1 < args.length; i = i + 2) {
        environment[args[i]] = args[i+1];
    }
    if (environment.msgno == '-1') { // a sentinel value
        delete environment.msgno;
    }
    if (environment.MSG_FILENAME) {
        var msgFileName = path.join(PackItMsgs, environment.MSG_FILENAME);
        environment.message = fs.readFileSync(msgFileName, ENCODING);
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
    return environment;
}

function respond(res, code, message) {
    if (message) {
        console.log(message);
        res.status(code).send(message);
    } else {
        res.sendStatus(code);
    }
}

/** Handle an HTTP GET /form-id request. */
function onGetForm(formId, res) {
    var form = openForms[formId];
    if (!form) {
        respond(res, NOT_FOUND, 'form ' + formId + ' is not open');
    } else {
        keepAlive(formId);
        var environment = getEnvironment(form.argv);
        environment.pingURL = '/ping-' + formId;
        environment.submitURL = '/submit-' + formId;
        console.log('form ' + formId + ' viewed');
        console.log(environment);
        res.send(getForm(environment));
    }
}

function getForm(environment) {
    if (!environment.filename) {
        throw new Error('form file name is ' + environment.filename);
    }
    var formFileName = path.join(PackItForms, environment.filename);
    if (!fs.existsSync(formFileName)) {
        throw new Error('no form file ' + formFileName);
    }
    var form = fs.readFileSync(path.join(PackItForms, environment.filename), ENCODING);
    form = expandDataIncludes(form, JSON.stringify(environment));
    return form;
}

/* Expand data-include-html elements, for example:
  <div data-include-html="ics-header">
    {
      "5.": "PRIORITY",
      "9b.": "{{msgno|msgno2name}}"
    }
  </div>
*/
function expandDataIncludes(data, environmentJSON) {
    var oldData = data;
    while(true) {
        var newData = expandDataInclude(oldData, environmentJSON);
        if (newData == oldData) {
            return oldData;
        }
        oldData = newData;
    }
}

function expandDataInclude(data, query_objectJSON) {
    const target = /<\s*div\s+data-include-html\s*=\s*"[^"]*"\s*>[^<]*<\/\s*div\s*>/gi;
    return data.replace(target, function(found) {
        var matches = found.match(/"([^"]*)"\s*>([^<]*)/);
        var name = matches[1];
        var init = matches[2].trim();
        // Read a file from pack-it-forms:
        var fileName = path.join(PackItForms, 'resources', 'html', name + '.html')
        var result = fs.readFileSync(fileName, ENCODING);
        // Remove the enclosing <div></div>:
        result = result.replace(/^\s*<\s*div\s*>\s*(.*)/i, '$1');
        result = result.replace(/(.*)<\/\s*div\s*>\s*$/i, '$1');
        if (name == 'submit-buttons') {
            // Add some additional stuff:
            var callprefixesJSON =
                fs.readFileSync(path.join(PackItForms, 'cfgs', 'msgno-prefixes.json'), ENCODING)
                  .trim();
            result += expandVariables(
                fs.readFileSync(path.join('bin', 'after-submit-buttons.html'), ENCODING),
                {query_object: query_objectJSON,
                 callprefixes: callprefixesJSON});
        }
        if (init) {
            result += `<script type="text/javascript">
  var formDefaultValues;
  if (!formDefaultValues) {
      formDefaultValues = [];
  }
  formDefaultValues.push(${init});
</script>`;
        }
        return result;
    });
}

function expandVariables(data, values) {
    for (var v in values) {
        data = data.replace(new RegExp(enquoteRegex('{{' + v + '}}'), 'g'), values[v]);
    }
    return data;
}

function encodeHTML(text) {
    // Crude but adequate:
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function enquoteRegex(text) {
    // Crude but adequate:
    return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}
