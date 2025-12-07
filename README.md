# HumanifyJS
> Deobfuscate Javascript code using LLMs ("AI")

This tool uses Anthropic's Claude API and other tools to deobfuscate, unminify,
transpile, decompile and unpack Javascript code. Note that LLMs don't perform
any structural changes – they only provide hints to rename variables and
functions. The heavy lifting is done by Babel on AST level to ensure code stays
1-1 equivalent.

### Version 2 is out!

v2 highlights compared to v1:
* Python not required anymore!
* A lot of tests, the codebase is actually maintanable now
* Renewed CLI tool `humanify` installable via npm

## Example

Given the following minified code:

```javascript
function a(e,t){var n=[];var r=e.length;var i=0;for(;i<r;i+=t){if(i+t<r){n.push(e.substring(i,i+t))}else{n.push(e.substring(i,r))}}return n}
```

The tool will output a human-readable version:

```javascript
function splitString(inputString, chunkSize) {
  var chunks = [];
  var stringLength = inputString.length;
  var startIndex = 0;
  for (; startIndex < stringLength; startIndex += chunkSize) {
    if (startIndex + chunkSize < stringLength) {
      chunks.push(inputString.substring(startIndex, startIndex + chunkSize));
    } else {
      chunks.push(inputString.substring(startIndex, stringLength));
    }
  }
  return chunks;
}
```

## Getting started

### Installation

Prerequisites:
* Node.js >=20

The preferred way to install the tool is via npm:

```shell
npm install -g humanifyjs
```

This installs the tool to your machine globally. After the installation is done,
you should be able to run the tool via:

```shell
humanify
```

If you want to try it out before installing, you can run it using `npx`:

```
npx humanifyjs
```

This will download the tool and run it locally. Note that all examples here
expect the tool to be installed globally, but they should work by replacing
`humanify` with `npx humanifyjs` as well.

### Usage

You'll need an Anthropic API key. You can get one by signing up at
https://console.anthropic.com/.

There are several ways to provide the API key to the tool:

```shell
humanify anthropic --apiKey="your-token" obfuscated-file.js
```

Alternatively you can also use an environment variable `ANTHROPIC_API_KEY`. Use
`humanify --help` to see all available options.

## Features

The main features of the tool are:
* Uses Anthropic Claude to get smart suggestions to rename variable and function
  names
* Uses custom and off-the-shelf Babel plugins to perform AST-level unmangling
* Uses Webcrack to unbundle Webpack bundles

## Contributing

If you'd like to contribute, please fork the repository and use a feature
branch. Pull requests are warmly welcome.

## Licensing

The code in this project is licensed under MIT license.
