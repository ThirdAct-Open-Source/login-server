import {IError} from '@znetstar/attic-common/lib/Error/IError';
import {
  IErrorBroker,
  ConstructibleError,
  PartialIError
} from "@znetstar/attic-common/lib/Server/IErrorBroker";

export type ErrorMap<T extends IError> = Map<number, ConstructibleError<T>>;

export class ErrorBroker implements IErrorBroker {
  protected errorMap: ErrorMap<IError> = new Map<number, ConstructibleError<IError>>();
  protected errorNameMap: Map<string, number> = new Map<string, number>();
  protected builtInErrors: { [name: string]: ConstructibleError<IError> } = Object.freeze(require('@znetstar/attic-common/lib/Error'));

  constructor() {
    for (const name in this.builtInErrors) {
      const error: ConstructibleError<IError> = (this.builtInErrors as any)[name];

      this.setError(error);
    }
  }

  public setError(error: ConstructibleError<IError>, opts?: PartialIError) {
    const code = opts?.code || error.code;
    const name = opts?.name || error.name;

    this.errorMap.set(code, error);
    this.errorNameMap.set(name, code);
  }

  public getErrorByCode(code: number): ConstructibleError<IError>|void
  public getErrorByCode<T extends IError>(code: number): ConstructibleError<T>|void {
    return this.errorMap.get(code);
  }

  public getErrorByName(name: string): ConstructibleError<IError>|void
  public getErrorByName<T extends IError>(name: string): ConstructibleError<T>|void {
    let code = this.errorNameMap.get(name);
    if (code)
      return this.getErrorByCode(code);
  }
}
