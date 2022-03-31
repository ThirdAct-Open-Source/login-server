import ILocation from "@znetstar/attic-common/lib/ILocation";
import {IDriverGet, IDriverHead} from "@znetstar/attic-common";
import {IUser} from "../User";
import ApplicationContext from "../ApplicationContext";

export default abstract class Driver<T> implements IDriverGet<T>, IDriverHead<T> {
    constructor(public user?: IUser) {

    }
    public abstract get(location: ILocation): Promise<T>;
    public abstract head(location: ILocation): Promise<T>;
}
