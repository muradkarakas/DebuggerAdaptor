/*---------------------------------------------------------
 * Sodium Debugger Adaptor Protocol Implementation
 * by Murad Karakaş
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { window, InputBoxOptions } from 'vscode';
import { Mutex } from 'await-semaphore';
import { MockRuntime } from './mockRuntime';

export class SodiumUtils
{
	public static commandCounter = 0;
	public static mutex = new Mutex();
	private static _stdoutResolver: Function | undefined;

	public static ReleaseStdout(reply: string)
	{
		if (SodiumUtils._stdoutResolver) {
			let message: string = "    > REPLIED (" + SodiumUtils.commandCounter++ + "): " + reply;
			if (MockRuntime._trace)
				console.log(message);
			SodiumUtils._stdoutResolver();
		}
		SodiumUtils._stdoutResolver = undefined;
	}

	public static async WaitForStdout(): Promise<any>
	{
		SodiumUtils._stdoutResolver = await SodiumUtils.mutex.acquire();
		return SodiumUtils._stdoutResolver;
	}

	public static SendCommandToSodiumDebugger(runtime: MockRuntime, command: string): void
	{
		if (runtime && runtime.SodiumDebuggerProcess != null) {
			let message: string = ">>> COMMAND (" + SodiumUtils.commandCounter + "): " + command;
			runtime.SodiumDebuggerProcess.stdin.cork();
			runtime.SodiumDebuggerProcess.stdin.write(command);
			runtime.SodiumDebuggerProcess.stdin.uncork();
			if (MockRuntime._trace)
				console.log(message);
		}
	}

	public static ShowMessage(message: string)
	{
		vscode.window.showInformationMessage("SD: " + message);
	}

	public static SanitizePathForSodiumDebugger(path: string): string
	{
		return path.replace("C:", "c:").replace("D:", "d:").replace("E:", "d:");
	}

	public static async GetInput(options: InputBoxOptions): Promise<any>
	{
		let retval: any = undefined;

		let input = window.showInputBox(options);
		await input.then(value => {
			if (value)
				retval = value;
		});
		return Promise.resolve(retval);
	}

}