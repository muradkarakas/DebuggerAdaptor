import { window, InputBoxOptions } from 'vscode';


export class SodiumUtils {

	public static async GetInput(options: InputBoxOptions): Promise<any> {
		let retval: any = undefined;

		let input = window.showInputBox(options);
		await input.then(value => {
			if (value)
				retval = value;
		});
		return Promise.resolve(retval);
	}

}