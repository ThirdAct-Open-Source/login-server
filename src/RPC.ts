import { Server, Request, HTTPTransportClientResponse, MethodExecutionContext  } from 'multi-rpc/lib';
import { IRPC }  from '@znetstar/attic-common/lib';
import Config from './Config';
import { nanoid } from 'nanoid';

export interface AtticMethodExecutionContext {
    clientRequest: HTTPTransportClientResponse;
}

export interface IAtticRPCServer {
    methods: IRPC&AtticMethodExecutionContext;
}

export const RPCServer = <IAtticRPCServer&Server>(new Server());

RPCServer.methods.generateId = async function (size?: number): Promise<string> {
    return nanoid(Number(size) ? size : Config.shortUrlSize);
}

RPCServer.methods.listDrivers = async () => Config.drivers.slice(0);
RPCServer.methods.listResolverTypes = async () => Config.resolverTypes.slice(0);
RPCServer.methods.listEntityTypes = async () => Config.entityTypes.slice(0);

// RPCServer.methods.listUserTypes = async () => Config.userTypes.slice(0);


export default RPCServer;
