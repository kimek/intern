import registerSuite = require('intern!object');
import * as assert from 'intern/chai!assert';
import testRegisterSuite from 'src/lib/interfaces/object';
import * as main from 'src/main';
import Suite from 'src/lib/Suite';
import Test from 'src/lib/Test';

const originalExecutor = main.executor;
let rootSuites: Suite[];

registerSuite({
	name: 'intern/lib/interfaces/object',

	setup() {
		main.setExecutor(<any> {
			register: function (callback: (value: Suite, index: number, array: Suite[]) => void) {
				rootSuites.forEach(callback);
			}
		});
	},

	teardown() {
		main.setExecutor(originalExecutor);
	},

	'Object interface registration': {
		setup() {
			// Normally, the root suites are set up once the runner or client are configured, but we do not execute
			// the Intern under test
			rootSuites = [
				new Suite({ name: 'object test 1' }),
				new Suite({ name: 'object test 2' })
			];
		},

		registration() {
			testRegisterSuite({
				name: 'root suite 1',

				'nested suite': {
					'nested test': function () {}
				},

				'regular test': function () {}
			});

			testRegisterSuite(function () {
				return {
					name: 'root suite 2',

					'test 2': function () {}
				};
			});

			let mainSuite: Suite[];
			for (let i = 0; (mainSuite = <Suite[]> (rootSuites[i] && rootSuites[i].tests)); ++i) {
				assert.strictEqual(mainSuite[0].name, 'root suite 1',
					'Root suite 1 should be the one named "root suite 1"');
				assert.instanceOf(mainSuite[0], Suite, 'Root suite 1 should be a Suite instance');

				assert.strictEqual(mainSuite[0].tests.length, 2, 'Root suite should have two tests');

				assert.strictEqual(mainSuite[0].tests[0].name, 'nested suite',
					'First test of root suite should be the one named "nested suite"');
				assert.instanceOf(mainSuite[0].tests[0], Suite, 'Nested test suite should be a Suite instance');

				assert.strictEqual((<Suite> (<Suite> mainSuite[0]).tests[0]).tests.length, 1, 'Nested suite should only have one test');

				assert.strictEqual((<Suite> (<Suite> mainSuite[0]).tests[0]).tests[0].name, 'nested test',
					'Test in nested suite should be the one named "test nested suite');
				assert.instanceOf((<Suite> (<Suite> mainSuite[0]).tests[0]).tests[0], Test,
					'Test in nested suite should be a Test instance');

				assert.strictEqual(mainSuite[0].tests[1].name, 'regular test',
					'Last test in root suite should be the one named "regular test"');
				assert.instanceOf(mainSuite[0].tests[1], Test, 'Last test in root suite should a Test instance');

				assert.strictEqual(mainSuite[1].name, 'root suite 2',
					'Root suite 2 should be the one named "root suite 2"');
				assert.instanceOf(mainSuite[1], Suite, 'Root suite 2 should be a Suite instance');

				assert.strictEqual(mainSuite[1].tests.length, 1, 'Root suite 2 should have one test');

				assert.strictEqual(mainSuite[1].tests[0].name, 'test 2',
					'The test in root suite 2 should be the one named "test 2"');
				assert.instanceOf(mainSuite[1].tests[0], Test, 'test 2 should be a Test instance');
			}
		}
	},

	'Object interface lifecycle methods': {
		setup() {
			rootSuites = [
				new Suite({ name: 'object test 1' })
			];
		},

		'lifecycle methods'() {
			const suiteParams: any = { name: 'root suite' };
			const results: string[] = [];
			const expectedResults = ['before', 'arg', 'beforeEach', 'arg', 'afterEach', 'arg', 'after', 'arg'];
			const lifecycleMethods = ['setup', 'beforeEach', 'afterEach', 'teardown'];

			expectedResults.forEach(function (method) {
				suiteParams[method] = function (arg: any) {
					results.push(method, arg);
				};
			});

			testRegisterSuite(suiteParams);

			lifecycleMethods.forEach(function (method: string) {
				(<{ [key: string]: any }> (<Suite> rootSuites[0]).tests[0])[method]('arg');
			});

			assert.deepEqual(results, expectedResults, 'object interface methods should get called when ' +
				'corresponding Suite methods get called.');

		}
	}
});
