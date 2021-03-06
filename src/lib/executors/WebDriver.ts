import { initialize } from './Executor';
import Node, { Config as BaseConfig, Events as BaseEvents } from './Node';
import Tunnel, { TunnelOptions, DownloadProgressEvent } from 'digdug/Tunnel';
import BrowserStackTunnel, { BrowserStackOptions } from 'digdug/BrowserStackTunnel';
import SeleniumTunnel, { SeleniumOptions } from 'digdug/SeleniumTunnel';
import SauceLabsTunnel from 'digdug/SauceLabsTunnel';
import TestingBotTunnel from 'digdug/TestingBotTunnel';
import CrossBrowserTestingTunnel from 'digdug/CrossBrowserTestingTunnel';
import NullTunnel from 'digdug/NullTunnel';
import Server from '../Server';
import { deepMixin } from '@dojo/core/lang';
import Task from '@dojo/core/async/Task';
import LeadfootServer from 'leadfoot/Server';
import ProxiedSession from '../ProxiedSession';
import resolveEnvironments from '../resolveEnvironments';
import Suite, { isSuite } from '../Suite';
import RemoteSuite from '../RemoteSuite';
import { parseValue, pullFromArray } from '../common/util';
import { expandFiles } from '../node/util';
import Environment from '../Environment';
import Command from 'leadfoot/Command';
import Pretty from '../reporters/Pretty';
import Benchmark from '../reporters/Benchmark';
import Runner from '../reporters/Runner';
import Promise from '@dojo/shim/Promise';

/**
 * The WebDriver executor is used to run unit tests in a remote browser, and to run functional tests against a remote
 * browser, using the WebDriver protocol.
 *
 * Unit and functional tests are handled fundamentally differently. Unit tests are only handled as module names here;
 * they will be loaded in a remote browser session, not in this executor. Functional tests, on the other hand, are loaded
 * and executed directly in this executor.
 */
export default class WebDriver extends Node<Events, Config> {
	static initialize(config?: Partial<Config>) {
		return initialize<Events, Config, WebDriver>(WebDriver, config);
	}

	server: Server;

	tunnel: Tunnel;

	protected _rootSuites: Suite[];

	protected _tunnels: { [name: string]: typeof Tunnel };

	constructor(config?: Partial<Config>) {
		super(config);

		this.configure({
			capabilities: { 'idle-timeout': 60 },
			connectTimeout: 30000,
			environments: <EnvironmentSpec[]>[],
			maxConcurrency: Infinity,
			reporters: [{ reporter: 'runner' }],
			runInSync: false,
			serveOnly: false,
			serverPort: 9000,
			serverUrl: 'http://localhost:9000',
			tunnel: 'selenium',
			tunnelOptions: { tunnelId: String(Date.now()) }
		});

		this._tunnels = {};

		this.registerTunnel('null', NullTunnel);
		this.registerTunnel('selenium', SeleniumTunnel);
		this.registerTunnel('saucelabs', SauceLabsTunnel);
		this.registerTunnel('browserstack', BrowserStackTunnel);
		this.registerTunnel('testingbot', TestingBotTunnel);
		this.registerTunnel('cbt', CrossBrowserTestingTunnel);

		this.registerReporter('pretty', Pretty);
		this.registerReporter('runner', Runner);
		this.registerReporter('benchmark', Benchmark);

		if (config) {
			this.configure(config);
		}
	}

	get environment() {
		return 'webdriver';
	}

	/**
	 * Override Executor#addSuite to handle WebDriver's multiple root suites
	 */
	addSuite(adder: (parentSuite: Suite) => void) {
		this._rootSuites.forEach(adder);
	}

	registerTunnel(name: string, Class: typeof Tunnel) {
		this._tunnels[name] = Class;
	}

	protected _afterRun() {
		return super._afterRun()
			.finally(() => {
				const promises: Promise<any>[] = [];
				if (this.server) {
					promises.push(this.server.stop().then(() => this.emit('serverEnd', this.server)));
				}
				if (this.tunnel) {
					promises.push(this.tunnel.stop().then(() => this.emit('tunnelStop', { tunnel: this.tunnel })));
				}
				return Promise.all(promises)
					// We do not want to actually return an array of values, so chain a callback that resolves to
					// undefined
					.then(() => {}, error => this.emit('error', error));
			});
	}

	protected _beforeRun() {
		const config = this.config;

		const promise = super._beforeRun().then(() => {
			const server = this._createServer();
			return server.start().then(() => {
				this.server = server;
				return this.emit('serverStart', server);
			});
		});

		// If we're in serveOnly mode, just start the server server. Don't create session suites or start a tunnel.
		if (config.serveOnly) {
			return promise.then(() => {
				// This is normally handled in Executor#run, but in serveOnly mode we short circuit the normal sequence
				// Pause indefinitely until canceled
				return new Task(() => {}).finally(() => this.server && this.server.stop());
			});
		}

		return promise
			.then(() => {
				if (config.environments.length === 0) {
					throw new Error('No environments specified');
				}

				if (config.tunnel === 'browserstack') {
					const options = <BrowserStackOptions>config.tunnelOptions;
					options.servers = options.servers || [];
					options.servers.push(config.serverUrl);
				}

				if (config.functionalSuites.length + config.suites.length + config.browserSuites.length > 0) {
					let TunnelConstructor = this._tunnels[config.tunnel];
					this.tunnel = new TunnelConstructor(this.config.tunnelOptions);
				}
			})
			.then(() => {
				const tunnel = this.tunnel;
				if (!tunnel) {
					return;
				}

				tunnel.on('downloadprogress', progress => {
					this.emit('tunnelDownloadProgress', { tunnel, progress });
				});

				tunnel.on('status', status => {
					this.emit('tunnelStatus', { tunnel, status: status.status });
				});

				config.capabilities = deepMixin(tunnel.extraCapabilities, config.capabilities);
			})
			.then(() => this._createSessionSuites())
			.then(() => {
				const tunnel = this.tunnel;
				if (!tunnel) {
					return;
				}

				return tunnel.start().then(() => this.emit('tunnelStart', { tunnel }));
			});
	}

	/**
	 * Creates an instrumenting server for sending instrumented code to the remote environment and receiving
	 * data back from the remote environment.
	 */
	protected _createServer() {
		// Need an explicitly declared variable for typing
		const server: Server = new Server({
			basePath: this.config.basePath,
			instrumenterOptions: this.config.instrumenterOptions,
			excludeInstrumentation: this.config.excludeInstrumentation,
			executor: this,
			instrument: true,
			port: this.config.serverPort,
			runInSync: this.config.runInSync,
			socketPort: this.config.socketPort
		});
		return server;
	}

	/**
	 * Creates suites for each environment in which tests will be executed.
	 */
	protected _createSessionSuites() {
		const tunnel = this.tunnel;
		if (!this.tunnel) {
			return;
		}

		const config = this.config;

		if (config.environments.length === 0) {
			this._rootSuites = [];
			return;
		}

		const leadfootServer = new LeadfootServer(tunnel.clientUrl, {
			proxy: tunnel.proxy
		});

		leadfootServer.sessionConstructor = ProxiedSession;

		return tunnel.getEnvironments().then(tunnelEnvironments => {
			const executor = this;

			this._rootSuites = resolveEnvironments(
				config.capabilities,
				config.environments,
				tunnelEnvironments
			).map(environmentType => {
				// Create a new root suite for each environment
				const suite = new Suite({
					name: String(environmentType),
					publishAfterSetup: true,
					grep: config.grep,
					bail: config.bail,
					tests: [],
					timeout: config.defaultTimeout,
					executor: this,

					before() {
						executor.log('Creating session for', environmentType);
						return leadfootServer.createSession<ProxiedSession>(environmentType).then(session => {
							session.executor = executor;
							session.coverageEnabled = config.excludeInstrumentation !== true;
							session.coverageVariable = config.instrumenterOptions.coverageVariable;
							session.serverUrl = config.serverUrl;
							session.serverBasePathLength = config.basePath.length;

							this.executor.log('Created session:', session.capabilities);

							let remote: Remote = <Remote>new Command(session);
							remote.environmentType = new Environment(session.capabilities);
							this.remote = remote;

							return executor.emit('sessionStart', remote);
						});
					},

					after() {
						const remote = this.remote;

						if (remote) {
							const endSession = () => {
								return executor.emit('sessionEnd', remote).then(() => {
									// Check for an error in this suite or a sub-suite. This check is a bit more
									// involved than just checking for a local suite error or failed tests since
									// sub-suites may have failures that don't result in failed tests.
									function hasError(suite: Suite): boolean {
										if (suite.error != null || suite.numFailedTests > 0) {
											return true;
										}
										return suite.tests.filter(isSuite).some(hasError);
									}
									return tunnel.sendJobState(remote.session.sessionId, { success: !hasError(this) });
								});
							};

							if (
								config.leaveRemoteOpen === true ||
								(config.leaveRemoteOpen === 'fail' && this.numFailedTests > 0)
							) {
								return endSession();
							}

							return remote.quit().finally(endSession);
						}
					}
				});

				// If browser-compatible unit tests were added to this executor, add a RemoteSuite to the session suite.
				// The RemoteSuite will run the suites listed in executor.config.suites.
				if (config.suites.length + config.browserSuites.length > 0) {
					suite.add(new RemoteSuite());
				}

				return suite;
			});
		});
	}

	protected _processOption(name: keyof Config, value: any) {
		switch (name) {
			case 'serverUrl':
				this.config[name] = parseValue(name, value, 'string');
				break;

			case 'capabilities':
			case 'tunnelOptions':
				this.config[name] = parseValue(name, value, 'object');
				break;

			// Must be a string, object, or array of (string | object)
			case 'environments':
				if (typeof value === 'string') {
					try {
						value = parseValue(name, value, 'object');
					}
					catch (error) {
						value = { browserName: value };
					}
				}

				if (!Array.isArray(value)) {
					value = [value];
				}

				this.config[name] = value.map((val: any) => {
					if (typeof val === 'string') {
						try {
							val = parseValue(name, val, 'object');
						}
						catch (error) {
							val = { browserName: val };
						}
					}
					if (typeof val !== 'object') {
						throw new Error(`Invalid value "${value}" for ${name}; must (string | object)[]`);
					}
					// Do some very basic normalization
					if (val.browser && !val.browserName) {
						val.browserName = val.browser;
					}
					return val;
				});
				break;

			case 'tunnel':
				if (typeof value !== 'string' && typeof value !== 'function') {
					throw new Error(`Invalid value "${value}" for ${name}`);
				}
				this.config[name] = value;
				break;

			case 'leaveRemoteOpen':
			case 'serveOnly':
			case 'runInSync':
				this.config[name] = parseValue(name, value, 'boolean');
				break;

			case 'browserSuites':
			case 'functionalSuites':
				this.config[name] = parseValue(name, value, 'string[]');
				break;

			case 'connectTimeout':
			case 'maxConcurrency':
			case 'environmentRetries':
			case 'serverPort':
			case 'socketPort':
				this.config[name] = parseValue(name, value, 'number');
				break;

			default:
				super._processOption(name, value);
		}
	}

	/**
	 * Override Executor#_loadSuites to pass config.functionalSuites as config.suites to the loader.
	 */
	protected _loadSuites() {
		const config = deepMixin({}, this.config, { suites: this.config.functionalSuites });
		return super._loadSuites(config);
	}

	protected _resolveConfig() {
		const config = this.config;

		return super._resolveConfig().then(() => {
			if (!config.serverPort) {
				config.serverPort = 9000;
			}

			if (!config.socketPort) {
				config.socketPort = config.serverPort + 1;
			}

			if (!config.serverUrl) {
				config.serverUrl = 'http://localhost:' + config.serverPort;
			}

			config.serverUrl = config.serverUrl.replace(/\/*$/, '/');

			if (config.browserSuites == null) {
				config.browserSuites = [];
			}

			if (config.functionalSuites == null) {
				config.functionalSuites = [];
			}

			if (!config.capabilities.name) {
				config.capabilities.name = 'intern';
			}

			const buildId = process.env.TRAVIS_COMMIT || process.env.BUILD_TAG;
			if (buildId) {
				config.capabilities.build = buildId;
			}

			return Promise.all(['browserSuites', 'functionalSuites'].map(property => {
				return expandFiles(config[property]).then(expanded => {
					config[property] = expanded;
				});
			})).then(() => {});
		});
	}

	/**
	 * Runs each of the root suites, limited to a certain number of suites at the same time by `maxConcurrency`.
	 */
	protected _runTests(): Task<any> {
		this.log('Running with maxConcurrency', this.config.maxConcurrency);

		const rootSuites = this._rootSuites;
		const queue = new FunctionQueue(this.config.maxConcurrency || Infinity);
		const numSuitesToRun = rootSuites.length;
		let numSuitesCompleted = 0;

		this.log('Running', numSuitesToRun, 'suites');

		return Task.all(rootSuites.map(suite => {
			this.log('Queueing suite', suite.name);
			return queue.enqueue(() => {
				this.log('Running suite', suite.name);
				return suite.run().finally(() => {
					numSuitesCompleted++;
					this.log('Finished suite', suite.name, '(', numSuitesCompleted, 'of', numSuitesToRun, ')');
					if (numSuitesCompleted === numSuitesToRun) {
						// All suites have finished running, so emit coverage
						this.log('Emitting coverage');
						return this._emitCoverage();
					}
				});
			});
		}));
	}
}

export interface Config extends BaseConfig {
	capabilities: {
		name?: string;
		build?: string;
		[key: string]: any;
	};

	/** Time to wait for contact from a remote server */
	connectTimeout: number;

	/** A list of remote environments */
	environments: EnvironmentSpec[];

	leaveRemoteOpen: boolean | 'fail';
	maxConcurrency: number;
	serveOnly: boolean;
	serverPort: number;
	serverUrl: string;
	runInSync: boolean;
	socketPort?: number;
	tunnel: string;
	tunnelOptions?: TunnelOptions | BrowserStackOptions | SeleniumOptions;
}

export interface Remote extends Command<any> {
	environmentType?: Environment;
	setHeartbeatInterval(delay: number): Command<any>;
}

export interface EnvironmentSpec {
	browserName: string;
	[key: string]: any;
}

export interface TunnelMessage {
	tunnel: Tunnel;
	progress?: DownloadProgressEvent;
	status?: string;
}

export interface Events extends BaseEvents {
	/** A test server has stopped */
	serverEnd: Server;

	/** A test server was started */
	serverStart: Server;

	/** A remote session has been opened */
	sessionStart: Remote;

	/** A remote session has ended */
	sessionEnd: Remote;

	/** Emitted as a Tunnel executable download is in process */
	tunnelDownloadProgress: TunnelMessage;

	/** A WebDriver tunnel has been opened */
	tunnelStart: TunnelMessage;

	/** A status update from a WebDriver tunnel */
	tunnelStatus: TunnelMessage;

	/** A WebDriver tunnel has been stopped */
	tunnelStop: TunnelMessage;
}

/**
 * A basic FIFO function queue to limit the number of currently executing asynchronous functions.
 */
class FunctionQueue {
	readonly maxConcurrency: number;
	queue: any[];
	activeTasks: Task<any>[];
	funcTasks: Task<any>[];

	constructor(maxConcurrency: number) {
		this.maxConcurrency = maxConcurrency;
		this.queue = [];
		this.activeTasks = [];
		this.funcTasks = [];
	}

	enqueue(func: () => Task<any>) {
		const funcTask = new Task((resolve, reject) => {
			this.queue.push({ func, resolve, reject });
		});
		this.funcTasks.push(funcTask);

		if (this.activeTasks.length < this.maxConcurrency) {
			this.next();
		}

		return funcTask;
	}

	clear() {
		this.activeTasks.forEach(task => task.cancel());
		this.funcTasks.forEach(task => task.cancel());
		this.activeTasks = [];
		this.funcTasks = [];
		this.queue = [];
	}

	next() {
		if (this.queue.length > 0) {
			const { func, resolver, rejecter } = this.queue.shift();
			const task = func().then(resolver, rejecter).finally(() => {
				// Remove the task from the active task list and kick off the next task
				pullFromArray(this.activeTasks, task);
				this.next();
			});
			this.activeTasks.push(task);
		}
	}
}
