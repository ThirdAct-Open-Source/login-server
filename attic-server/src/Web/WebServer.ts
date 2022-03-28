import express, {Router} from 'express';
import {ClientRequest, EncodeToolsSerializer, Response, RPCError, Transport} from 'multi-rpc';
import {ExpressTransport} from 'multi-rpc-express-transport';
import ResolverMiddleware from './ResolverMiddleware';
import {RPCServer} from '../RPC';
import Config from '../Config';
import {Server as HTTPServer} from 'http';
import SessionMiddleware, {CookieMiddleware} from "./SessionMiddleware";
import AuthMiddlewares, {AuthMiddleware, restrictScopeMiddleware} from "./AuthMiddleware";
import ApplicationContext, {ListenStatus} from "../ApplicationContext";
import {IError} from "@znetstar/attic-common/lib/Error/IError";
import * as ws from 'ws';
import * as _ from 'lodash';
import {initDocumentSync} from "./DocumentSyncMiddleware";
import {makeBinaryEncoders, ToPojo} from '@thirdact/to-pojo/lib/toPojo';
import {
  BinaryEncoding,
  EncodeTools as EncodeTools,
  EncodingOptions,
  MimeTypesSerializationFormat,
  SerializationFormat,
  SerializationFormatMimeTypes
} from "@znetstar/encode-tools/lib/EncodeTools";

interface HTTPErrorOpts { httpUrl?: string, httpMethod?: string; };
const multer  = require('multer')

function prepareWebError(error: IError|Error|RPCError, httpOpts?: HTTPErrorOpts): IError {
    let err: IError&HTTPErrorOpts;
    if (Array.isArray(error) && typeof(error[0]) === 'number') {
        err = {
            code: 0,
            httpCode: error[0] || 500,
            message: error[1],
            stack: _.get(error, 'stack'),
            ...(httpOpts || {})
        };
    } else if ((error as RPCError).data)  {
        err = {
            code: _.get(error, 'data.code') || _.get(error, 'code'),
            httpCode: _.get(error, 'data.httpCode') || _.get(error, 'httpCode') || 500,
            message: _.get(error, 'data.message') || _.get(error, '.message'),
            stack: _.get(error, 'data.stack') || _.get(error, 'stack'),
            ...(httpOpts || {})
        }
    } else {
        err = {
            code: _.get(error, 'code') || _.get(error, '__proto__.constructor.code'),
            httpCode: _.get(error, 'httpCode') || _.get(error, '__proto__.constructor.httpCode') || 500,
            message: _.get(error, 'message') || _.get(error, '__proto__.constructor.message'),
            stack: _.get(error, 'stack'),
            ...(httpOpts || {})
        }
    }

    return err;
}

function processWebError(error: IError|Error|RPCError, httpOpts?: HTTPErrorOpts): IError {
    let err = prepareWebError(error, httpOpts);

    ApplicationContext.logs.error(err);

    return err;
}

export function handleError(error: any, req: any, res: any) {
    let err = processWebError(error, { httpMethod: req.method, httpUrl: req.originalUrl });

    res.status(err.httpCode || 500).send({ error: err });
}

export function handleErrorMiddleware() {
  return (handleError);
}
export const DEFAULT_ENCODE_OPTIONS:  EncodingOptions = Object.freeze({
  serializationFormat: SerializationFormat.json
});

export class AtticExpressTransport extends ExpressTransport {
    protected onRequest(req: any, res: any) {
      let transport = this;
        const jsonData = (<Buffer>req.body);
        const rawReq = new Uint8Array(jsonData);

      const enc = new EncodeTools(DEFAULT_ENCODE_OPTIONS);
      let inFormat: SerializationFormat = enc.options.serializationFormat as SerializationFormat;
      let outFormat: SerializationFormat = inFormat;

      if (req.headers['content-type'])  {
        const mime =  (req.headers['content-type'] as string).split(';').shift() as string;
        const format = MimeTypesSerializationFormat.get(mime);
        if (format)
          inFormat = format as SerializationFormat;
      }
      if (req.headers['accept'])  {
        const mime =  (req.headers['accept'] as string).split(';').shift() as string;
        const format = MimeTypesSerializationFormat.get(mime);
        if (format)
          outFormat = format as SerializationFormat;
      }

      const inSerializer = new EncodeToolsSerializer({
        serializationFormat: inFormat,
        useToPojoBeforeSerializing: inFormat === SerializationFormat.json,
        encodeBuffersWhenUsingToPojo: inFormat === SerializationFormat.json
      });
      const outSerializer = new EncodeToolsSerializer({
        serializationFormat: outFormat,
        useToPojoBeforeSerializing: outFormat === SerializationFormat.json,
        encodeBuffersWhenUsingToPojo: outFormat === SerializationFormat.json
      });
        const body = inFormat === 'json' ? JSON.parse(Buffer.from(rawReq).toString('utf8')) : enc.deserializeObject<any>(rawReq, inFormat);

        ApplicationContext.logs.silly({
            method: `rpc.${body.method}.start`,
            params: [
                body
            ]
        });

        return restrictScopeMiddleware(
            `rpc.${body.method}`,
        )(req, res, (err: any) => {
            if (err) handleError(err, req ,res);
            else {
                const jsonData = (<Buffer>req.body);
                const rawReq = Buffer.from(jsonData);
                const serializer = new EncodeToolsSerializer({
                  serializationFormat: inFormat,
                  useToPojoBeforeSerializing: inFormat === SerializationFormat.json,
                  encodeBuffersWhenUsingToPojo: inFormat === SerializationFormat.json
                });
                const clientRequest = new ClientRequest(Transport.uniqueId(), (response?: Response) => {
                    const headers: any = {};


                    if (response) {
                        if (response.error) {
                            processWebError(response.error, {
                                httpMethod: req.method,
                                httpUrl: req.originalUrl
                            });

                            let error: any = {
                              message: response.error.message,
                              code: response.error.code,
                              httpCode: (response.error as any).httpCode,
                            };
                            if (response.error.data) {
                              error.data = {
                                message: response.error.data.message,
                                stack: response.error.data.stack,
                                code: response.error.data.code,
                                httpCode: response.error.data.httpCode
                              };
                            }

                            response.error = error;
                        }

                        const outBuf = enc.serializeObject(response, outFormat);
                        headers["Content-Type"] = SerializationFormatMimeTypes.get(outFormat);
                        headers['Content-Length'] = Buffer.from(outBuf).byteLength;

                        // response.error.message

                        res.writeHead(200, headers);
                        res.end(outBuf);
                    } else {
                        res.writeHead(204, headers);
                        res.end();
                    }

                    if (!response || !response.error)
                        ApplicationContext.logs.silly({
                            method: `rpc.${body.method}.complete`,
                            params: [
                                response ? response : void(0)
                            ]
                        });
                }, { req, res }, serializer);
                clientRequest.serializer = inSerializer
                ;

               transport.receive(jsonData, clientRequest);
            }
        });
    }
}

export let RPCTransport: AtticExpressTransport;
export let WebRouter: Router;


export let WebHTTPServer: HTTPServer;
export let WebExpress: any;
export let WebSocketServer: ws.Server;
export let WebSocketPaths = new Map<string, ws.Server>([
  [ '/sync', WebSocketServer ]
]);


export async function loadWebServer() {
    await ApplicationContext.emitAsync('launch.loadWebServer.start');

// @ts-ignore
    WebExpress = express();
    WebSocketServer = new ws.Server({ noServer: true });

    WebHTTPServer = new HTTPServer(WebExpress);

    await ApplicationContext.emitAsync('launch.loadWebServer.webMiddlewareInjectStart', {
      WebExpress,
      WebSocketServer,
      WebHTTPServer
    });
    WebHTTPServer.on('upgrade', function (request: any, socket: any, head: any) {
      (async () => {
        await new Promise<void>((resolve, reject) => {
          restrictScopeMiddleware(`sync.connect`)(request, {} as any, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
        const pathname = require('url').parse(request.url).pathname;
        let server = WebSocketPaths.get(pathname)
        if (server) {
          server.handleUpgrade(request, socket, head, function (ws) {
            server.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
      })().catch(() => {
        socket.destroy();
      });
    });

    WebRouter = express.Router();

    WebExpress.use(SessionMiddleware);
    WebExpress.use(AuthMiddleware);

    RPCTransport = new AtticExpressTransport(new EncodeToolsSerializer(DEFAULT_ENCODE_OPTIONS), WebRouter);


    await ApplicationContext.emitAsync('launch.loadWebServer.rpcMiddlewareInjectStart', {
      WebExpress,
      WebSocketServer,
      WebHTTPServer,
      RPCTransport,
      WebRouter
    });

    RPCServer.addTransport(RPCTransport);

    WebExpress.post('/rpc', WebRouter);

    if (Config.enableWebResolver) {
       WebExpress.use(CookieMiddleware);
        ApplicationContext.emit('Web.AuthMiddleware.loadAuthMiddleware', AuthMiddlewares);
        WebExpress.use(ResolverMiddleware);
    }

  await ApplicationContext.emitAsync('launch.loadWebServer.complete');

  WebExpress.use((error: any, req: any, res: any, next: any) => {
      handleError(error, req, res);
  });
}

ApplicationContext.once('launch.loadWebServer.complete', () => initDocumentSync());

export async function webServerListen() {
    await ApplicationContext.emitAsync('Web.webServerListen.start');
    let urls: string[] = [];
    if (Config.unixSocket) {
        WebHTTPServer.listen(Config.unixSocket);
        urls.push(`http+unix:${Config.unixSocket}`);
    } else if (Config.port) {
        WebHTTPServer.listen(Config.port, Config.host);
        urls.push(`http://${Config.host}:${Config.port}`);
    }
    await ApplicationContext.emitAsync('Web.webServerListen.complete', {
        urls
    } as ListenStatus);
}
