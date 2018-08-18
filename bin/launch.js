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
const fs = require('fs');
const path = require('path');

const ENCODING = 'utf-8';
const PackItForms = 'pack-it-forms';

switch(process.argv[2]) {
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

function openMessage() {
    var environment = {message_status: process.argv[2]};
    for (var i = 3; i + 1 < process.argv.length; i = i + 2) {
        environment[process.argv[i]] = process.argv[i+1];
    }
    if (environment.msgno == '-1') { // a sentinel value
        delete environment.msgno;
    }
    console.log(environment);
    if (!environment.filename) {
        throw new Error('form file name is ' + environment.filename);
    }
    var formFileName = path.join(PackItForms, environment.filename);
    if (!fs.existsSync(formFileName)) {
        throw new Error('no form file ' + formFileName);
    }
    var form = fs.readFileSync(path.join(PackItForms, environment.filename), ENCODING);
    form = expandDataIncludes(form, JSON.stringify(environment));
console.log(form);
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
