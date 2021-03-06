import registerSuite = require('intern!object');
import * as assert from 'intern/chai!assert';
import * as util from 'src/lib/util';
import Test from 'src/lib/Test';
import has = require('dojo/has');
import Promise = require('dojo/Promise');
import { IRequire } from 'dojo/loader';
import * as pathUtil from 'dojo/has!host-node?dojo/node!path';
import * as hook from 'dojo/has!host-node?dojo/node!istanbul/lib/hook';

declare const require: IRequire;
declare const global: any;

/* jshint maxlen:140 */
registerSuite({
	name: 'intern/lib/util',

	// TODO
	'.createQueue'() {},

	'.getErrorMessage': {
		'basic error logging'() {
			let message: string;

			message = util.getErrorMessage('oops');
			assert.strictEqual(message, 'oops');

			message = util.getErrorMessage(<any> { name: 'OopsError', message: 'oops2' });
			assert.strictEqual(message, 'OopsError: oops2\nNo stack or location');

			message = util.getErrorMessage(<any> { name: 'OopsError', message: 'oops3', fileName: 'did-it-again.js' });
			assert.strictEqual(message, 'OopsError: oops3\n  at did-it-again.js\nNo stack');

			message = util.getErrorMessage(<any> { name: 'OopsError', message: 'oops4', fileName: 'did-it-again.js',
				lineNumber: '1' });
			assert.strictEqual(message, 'OopsError: oops4\n  at did-it-again.js:1\nNo stack');

			message = util.getErrorMessage(<any> { name: 'OopsError', message: 'oops5', fileName: 'did-it-again.js', lineNumber: '1',
				columnNumber: '0' });
			assert.strictEqual(message, 'OopsError: oops5\n  at did-it-again.js:1:0\nNo stack');
		},

		'stack traces'() {
			let message: string;

			message = util.getErrorMessage(<any> { name: 'OopsError', message: 'oops6',
				stack: 'OopsError: oops6\nat did-it-again.js:1:0' });
			assert.strictEqual(message, 'OopsError: oops6\n  at <did-it-again.js:1:0>');

			message = util.getErrorMessage(<any> { name: 'OopsError', message: 'oops7', stack: 'oops7\nat did-it-again.js:1:0' });
			assert.strictEqual(message, 'OopsError: oops7\n  at <did-it-again.js:1:0>');

			message = util.getErrorMessage(<any> { name: 'OopsError', message: 'oops8', stack: 'at did-it-again.js:1:0' });
			assert.strictEqual(message, 'OopsError: oops8\n  at <did-it-again.js:1:0>');

			message = util.getErrorMessage(<any> { name: 'OopsError', message: 'oops9', stack: '\nat did-it-again.js:1:0' });
			assert.strictEqual(message, 'OopsError: oops9\n  at <did-it-again.js:1:0>');

			message = util.getErrorMessage(<any> { name: 'OopsError', stack: 'OopsError: oops10\nat did-it-again.js:1:0' });
			assert.strictEqual(message, 'OopsError: Unknown error\nOopsError: oops10\n  at <did-it-again.js:1:0>');

			// Chrome/IE stack
			message = util.getErrorMessage(<any> {
				name: 'OopsError',
				stack: '    at Foo (http://localhost:8080/test.js:2:8)\n    at http://localhost:8080/test.html:7:5'
			});
			assert.strictEqual(message, 'OopsError: Unknown error\n  at Foo  <test.js:2:8>\n  at <test.html:7:5>');

			// Safari/Firefox stack
			message = util.getErrorMessage(<any> {
				name: 'OopsError',
				stack: 'Foo@http://localhost:8080/test.js:2:8\nhttp://localhost:8080/test.html:7:5\nfail'
			});
			assert.strictEqual(message, 'OopsError: Unknown error\n  at Foo  <test.js:2:8>\n  at <test.html:7:5>\nfail');

			message = util.getErrorMessage(<any> { stack: 'undefined\nat did-it-again.js:1:0' });
			assert.strictEqual(message, 'Error: Unknown error\n  at <did-it-again.js:1:0>');
		},

		'source map from instrumentation'(this: Test) {
			if (!has('host-node')) {
				this.skip('requires Node.js');
			}

			const dfd = this.async();
			let wasInstrumented = false;

			// save any existing coverage data
			/* jshint node:true */
			const existingCoverage = global.__internCoverage;
			global.__internCoverage = undefined;

			// setup a hook to instrument our test module
			hook.hookRunInThisContext(function () {
				return true;
			}, function (code: string, file: string) {
				wasInstrumented = true;
				return util.instrument(code, file);
			});

			// restore everything
			// TODO: Use dfd.promise.finally in Intern 3
			function restore(error: Error) {
				global.__internCoverage = existingCoverage;
				hook.unhookRunInThisContext();
				if (error) {
					throw error;
				}
			}
			dfd.promise.then(restore, restore);

			require([ 'tests/unit/data/lib/util/foo' ], dfd.callback(function (foo) {
				assert.ok(wasInstrumented, 'Test module should have been instrumented');

				try {
					foo.run();
				}
				catch (error) {
					let expected = 'util/foo.js:4';
					if (pathUtil && pathUtil.sep !== '/') {
						expected = expected.replace(/\//g, pathUtil.sep);
					}
					assert.include(util.getErrorMessage(error), expected);
				}
			}));
		},

		'source map from file'(this: Test) {
			if (!has('host-node')) {
				this.skip('requires Node.js');
			}

			const dfd = this.async();

			require([ 'tests/unit/data/lib/util/bar' ], dfd.callback(function (Bar: any) {
				const bar = new Bar();
				try {
					bar.run();
				}
				catch (error) {
					assert.match(util.getErrorMessage(error), /\bbar.ts:5\b/);
				}
			}));
		},

		'source map from inline'(this: Test) {
			if (!has('host-node')) {
				this.skip('requires Node.js');
			}

			const dfd = this.async();

			require([ 'tests/unit/data/lib/util/baz' ], dfd.callback(function (Baz: any) {
				const baz = new Baz();
				try {
					baz.run();
				}
				catch (error) {
					assert.match(util.getErrorMessage(error), /\bbaz.ts:5\b/);
				}
			}));
		},

		'object diff'() {
			const error = {
				name: 'Error',
				message: 'Oops',
				showDiff: true,
				actual: { foo: <any[]> [] },
				expected: {},
				stack: ''
			};

			assert.include(
				util.getErrorMessage(<any> error),
				'Error: Oops\n\nE {}\nA {\nA   "foo": [\nA     length: 0\nA   ]\nA }\n\n',
				'Object diff should be included in message'
			);

			error.actual = <any> {};
			error.expected = <any> {};

			assert.include(
				util.getErrorMessage(<any> error),
				'Error: Oops\nNo stack',
				'No diff should exist for identical objects'
			);

			error.actual = <any> [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 ];
			error.expected = <any> [ 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 32 ];

			assert.include(
				util.getErrorMessage(<any> error),
				'Error: Oops\n\n  [\nE   0: 0,\nA   0: 1,\n    1: 2,\n    2: 3,\n    3: 4,\n    4: 5,\n[...]\n' +
				'    11: 12,\n    12: 13,\n    13: 14,\n    14: 15,\nE   15: 32,\nA   15: 16,\n    length: 16\n  ]\n\n',
				'Splits in long diffs should be indicated by an ellipsis'
			);
		}
	},

	'.instrument'(this: Test) {
		if (!has('host-node')) {
			this.skip('requires Node.js');
		}

		const code = util.instrument('console.log("\\u200C");', 'foo.js', {
			coverageVariable: 'foobaz',
			codeGenerationOptions: {
				verbatim: 'raw'
			}
		});
		assert.match(code, /__cov_\w+\.foobaz\b/, 'Expected specified coverage variable to be used for instrumentation');
		assert.match(code, /console\.log\(\("\\u200C"\)\)/, 'Expected unicode entity to be present in instrumented code');
	},

	'.isGlobModuleId'() {
		const globs = [
			'tests/unit/a*',
			'tests/unit/a*/*b',
			'tests/unit/a*/**/*',
			'tests/unit/**/*',
			'tests/[uU]nit/foo',
			'tests/unit/!(foo|bar)',
			'tests/unit/?(foo|bar)',
			'tests/unit/+(foo|bar)',
			'tests/unit/*(foo|bar)',
			'tests/unit/@(foo|bar)',
			'tests/unit/{foo,bar}'
		];
		const notGlobs = [
			'tests/unit/a',
			'tests/unit!',
			'tests/unit!()',
			'tests/unit!fs',
			'http://tests/unit?someArg'
		];

		globs.forEach(function (mid) {
			assert.isTrue(util.isGlobModuleId(mid), 'Expected ' + mid + ' to be classified as a glob');
		});

		notGlobs.forEach(function (mid) {
			assert.isFalse(util.isGlobModuleId(mid), 'Expected ' + mid + ' to not be classified as a glob');
		});
	},

	'.resolveModuleIds': {
		'null or undefined'() {
			const nullActual = util.resolveModuleIds(null);
			assert.isNull(nullActual, 'Unexpected resolution for null');

			const undefinedActual = util.resolveModuleIds(undefined);
			assert.isUndefined(undefinedActual, 'Unexpected resolution for undefined');
		},

		'non-glob'(this: Test) {
			if (!has('host-node')) {
				this.skip('requires Node.js');
			}

			const moduleIds = [
				'tests/unit/lib/util'
			];
			const expected = [
				'tests/unit/lib/util'
			];
			const actual = util.resolveModuleIds(moduleIds);
			assert.deepEqual(actual, expected, 'Non-glob MID should have been returned unchanged');
		},

		'single-level': function (this: Test) {
			if (!has('host-node')) {
				this.skip('requires Node.js');
			}

			const moduleIds = [
				`tests/unit/*`
			];
			const expected = [
				`tests/unit/all`,
				`tests/unit/main`,
				`tests/unit/order`
			];
			const actual = util.resolveModuleIds(moduleIds);
			assert.deepEqual(actual, expected, 'Unexpected resolution for single-level glob');
		},

		'multi-level'(this: Test) {
			if (!has('host-node')) {
				this.skip('requires Node.js');
			}

			const moduleIds = [
				`tests/functional/**/*`
			];
			const expected = [
				`tests/functional/lib/ProxiedSession`
			];
			const actual = util.resolveModuleIds(moduleIds);
			assert.deepEqual(actual, expected, 'Unexpected resolution for multi-level glob');
		},

		'non-JS files'(this: Test) {
			if (!has('host-node')) {
				this.skip('requires Node.js');
			}

			const moduleIds = [
				'tests/unit/lib/data/repoters/**/*'
			];
			const expected: any[] = [];
			const actual = util.resolveModuleIds(moduleIds);
			assert.deepEqual(actual, expected, 'Non-JS files should not be include in resolved values');
		}
	},

	'.serialize'() {
		/*jshint maxlen:160 */

		let object: any = {
			a: {
				b: {
					c: {}
				}
			}
		};

		assert.strictEqual(
			util.serialize(object),
			'{\n  "a": {\n    "b": {\n      "c": {}\n    }\n  }\n}',
			'Object properties should be correctly indented'
		);

		object = [ 'zero' ];
		object.foo = 'foo';

		assert.strictEqual(
			util.serialize(object),
			'[\n  0: "zero",\n  "foo": "foo",\n  length: 1\n]',
			'Arrays should be displayed with square brackets, non-numeric keys, and length'
		);

		object = [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 ];
		object.$foo = '$foo';

		assert.strictEqual(
			util.serialize(object),
			'[\n  0: 1,\n  1: 2,\n  2: 3,\n  3: 4,\n  4: 5,\n  5: 6,\n  6: 7,\n  7: 8,\n  8: 9,\n  9: 10,\n' +
			'  10: 11,\n  11: 12,\n  12: 13,\n  13: 14,\n  14: 15,\n  15: 16,\n  "$foo": "$foo",\n  length: 16\n]',
			'Numeric keys should be sorted in natural order and placed before properties'
		);

		object = function fn() {};
		object.foo = 'foo';

		if (has('function-name')) {
			assert.strictEqual(
				util.serialize(object),
				'fn({\n  "foo": "foo"\n})',
				'Functions should be displayed with the function name and static properties'
			);

			object = function () {};

			if (object.name === '') {
				// Browsers supporting ES2016 semantics will infer the name of an anonymous function from the
				// surrounding syntax, while pre-ES2016 browsers will leave it as an empty string (and serialize will
				// convert that to '<anonymous>').
				assert.strictEqual(
					util.serialize(object),
					'<anonymous>({})',
					'Functions without names should be given an anonymous name'
				);
			}
		}
		else {
			assert.strictEqual(
				util.serialize(object),
				'<function>({\n  "foo": "foo"\n})',
				'Functions should be displayed as a function with static properties'
			);
		}

		object = { s: 'string', n: 1.23, b: true, o: null, u: undefined, r: /foo/im, d: new Date(0) };
		assert.strictEqual(
			util.serialize(object),
			'{\n  "b": true,\n  "d": 1970-01-01T00:00:00.000Z,\n  "n": 1.23,\n  "o": null,\n  "r": /foo/im,' +
			'\n  "s": "string",\n  "u": undefined\n}',
			'All primitive JavaScript types should be represented accurately in the output'
		);
	}
});
