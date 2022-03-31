import {Request, Response} from "express";
import {IScopeContext} from "../Auth/AccessToken";
import { IHTTPResponse as IHTTPResponseBase, IHttpContext as IHttpContextBase } from '@znetstar/attic-common/lib/IRPC';
import {MimeTypesSerializationFormat} from "@znetstar/encode-tools/lib/EncodeTools";
import {EncodingOptions} from "@znetstar/encode-tools/lib/IEncodeTools";

export type IHTTPResponse = IHTTPResponseBase&{ body?: Buffer };

export type IHttpContext = IHttpContextBase&{
  req: Request,
  res: Response,
  scopeContext?: IScopeContext
}

export {
  getFormatsFromContext,
  unwrapPut
} from '@znetstar/attic-common/lib/IRPC';
