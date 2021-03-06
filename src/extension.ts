/*---------------------------------------------------------
 * Sodium Debugger Adaptor Protocol Implementation
 * by Murad Karakaş
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { SodiumDebugSession } from './SodiumDebug';
import * as Net from 'net';
import { MockRuntime } from './mockRuntime';

/*
 * The compile time flag 'runMode' controls how the debug adapter is run.
 * Please note: the test suite only supports 'external' mode.
 */
const runMode: 'external' | 'server' | 'inline' = 'inline';

export function activate(context: vscode.ExtensionContext)
{
	context.subscriptions.push(vscode.commands.registerCommand('extension.sodium-debug.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter the name of a sqlx file in the workspace folder",
			value: ""
		});
	}));

	// register a configuration provider for 'sodium' debug type
	const provider = new SodiumConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('sodium', provider));

	// debug adapters can be run in different ways by using a vscode.DebugAdapterDescriptorFactory:
	let factory: vscode.DebugAdapterDescriptorFactory;
	switch (runMode) {
		case 'server':
			// run the debug adapter as a server inside the extension and communicating via a socket
			factory = new MockDebugAdapterDescriptorFactory();
			break;

		case 'inline':
			// run the debug adapter inside the extension and directly talk to it
			factory = new InlineDebugAdapterFactory();
			break;

		case 'external': default:
			// run the debug adapter as a separate process
			factory = new DebugAdapterExecutableFactory();
			break;
		}

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('sodium', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}

	// override VS Code's default implementation of the debug hover
	/*
	vscode.languages.registerEvaluatableExpressionProvider('markdown', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {
			const wordRange = document.getWordRangeAtPosition(position);
			return wordRange ? new vscode.EvaluatableExpression(wordRange) : undefined;
		}
	});
	*/
}

export function deactivate() {
	// nothing to do
}

class SodiumConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration>
	{
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const fileExt = editor.document.uri.fsPath.indexOf(".sqlx");
			if (fileExt < 0) {
				return vscode.window.showInformationMessage("SodiumDebugger: Please open a file with 'sqlx' extension").then(_ => {
					return undefined;	// abort launch
				});
			}
			if (!config.program) {
				config.program = editor.document.uri.fsPath;
			}
		}

		// Reading session id full path from config
		if (config) {
			if (config.sessionId) {
				MockRuntime._SodiumSessionId = config.sessionId;
			}
			// Reading trace parameter from config
			if (config.trace) {
				MockRuntime._trace = config.trace;
			}

			// Reading SodiumDebugger.exe full path from config
			if (config.sdPath) {
				MockRuntime._sdPath = config.sdPath;
			}
		}

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) { /* && editor.document.languageId === 'markdown'*/
			if (editor) {
				config.type = 'sodium';
				config.name = 'Sodium Debugger';
				config.request = 'attach';
				config.program = editor.document.uri.fsPath;
			} else {
				return vscode.window.showInformationMessage("SodiumDebugger: Open a file to debug").then(_ => {
					return undefined;	// abort launch
				});
			}
		}
		return config;
	}
}

class DebugAdapterExecutableFactory implements vscode.DebugAdapterDescriptorFactory
{
	// The following use of a DebugAdapter factory shows how to control what debug adapter executable is used.
	// Since the code implements the default behavior, it is absolutely not neccessary and we show it here only for educational purpose.

	createDebugAdapterDescriptor(_session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): ProviderResult<vscode.DebugAdapterDescriptor> {
		// param "executable" contains the executable optionally specified in the package.json (if any)

		// use the executable specified in the package.json if it exists or determine it based on some other information (e.g. the session)
		if (!executable) {
			const command = "absolute path to my DA executable";
			const args = [
				"some args",
				"another arg"
			];
			const options = {
				cwd: "working directory for executable",
				env: { "VAR": "some value" }
			};
			executable = new vscode.DebugAdapterExecutable(command, args, options);
		}

		// make VS Code launch the DA executable
		return executable;
	}
}

class MockDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random port
			this.server = Net.createServer(socket => {
				const session = new SodiumDebugSession();
				session.setRunAsServer(true);
				session.start(<NodeJS.ReadableStream>socket, socket);
			}).listen(0);
		}

		// make VS Code connect to debug server
		return new vscode.DebugAdapterServer((<Net.AddressInfo>this.server.address()).port);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new SodiumDebugSession());
	}
}
