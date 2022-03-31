import Location, {ILocation, LocationSchema} from '../Location';
import { IEntity, default as Entity } from '../Entity';
import { Mongoose, Schema, Document } from 'mongoose';
import config from '../Config';
import mongoose from '../Database';
import { ObjectId } from 'mongodb';
import { IHTTPResourceEntity as IHTTPResourceEntityBase } from '@znetstar/attic-common/lib/IEntity'

export interface IHTTPResourceEntityModel {
    headers?: Map<string, string>;
    body?: Buffer;
    method?: string;
    status?: number;
}

export type IHTTPResourceEntity = IHTTPResourceEntityBase&IHTTPResourceEntityModel;

export const HTTPResourceEntitySchema = <Schema<IEntity&IHTTPResourceEntity>>(new (mongoose.Schema)({
    headers: {
        type: Map,
        required: false
    },
    body: {
        type: Buffer,
        required: false
    },
    method: {
        type: String,
        required: false
    },
    status: {
        type: Number,
        required: false
    }
}))

const HTTPResourceEntity = Entity.discriminator('HTTPResourceEntity', HTTPResourceEntitySchema)
export default HTTPResourceEntity;