import {IDriver} from "@znetstar/attic-common/lib/IDriver";
import Constructible from "../Constructible";
import ApplicationContext, { drivers } from "../ApplicationContext";

export async function loadDrivers() {
    await ApplicationContext.emitAsync('launch.loadDrivers.start');
    await ApplicationContext.emitAsync('launch.loadDrivers.complete');
}
