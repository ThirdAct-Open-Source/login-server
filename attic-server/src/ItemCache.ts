import Location, {ILocation, LocationSchema} from './Location';
import {Mongoose, Schema, Document, Model} from 'mongoose';
import mongoose, {redis} from './Database';
import config from "./Config";
import ApplicationContext from "./ApplicationContext";
const { xxhash64 } = require('hash-wasm');
import * as ObjectHash  from 'object-hash';
import * as msgpack from '@msgpack/msgpack';

export class ItemCache<I, T> {
    constructor(protected groupName: string, protected cacheExpireIn: number = config.cacheExpireIn) {

    }

    public get cacheEnabled() { return config.enableCache }

    public async serialize(item: T): Promise<Buffer> {
        return Buffer.from(msgpack.encode(item));
    }
    public async deserialize(item: Buffer): Promise<T> {
        return msgpack.decode<T>(item) as T;
    }

    public async getCacheKey(itemRef: I): Promise<string> {
        // @ts-ignore
        if (itemRef.toJSON) itemRef = itemRef.toJSON();
        let objectHash: Buffer = Buffer.from(JSON.stringify(itemRef), 'utf8');
        return [this.groupName, await xxhash64(objectHash)].join('.');
    }

    public async getObject(ref: I): Promise<T|null> {
        if (!this.cacheEnabled)
            return null;


        let key = await this.getCacheKey(ref);

        ApplicationContext.logs.silly({
            method: 'ItemCache.retrieveObject.start',
            params: [
                key
            ]
        });

        let itemRaw = await redis.getBuffer(key);

        if (!itemRaw)
            return null;

        let item = await this.deserialize(itemRaw) as T;

        ApplicationContext.logs.silly({
            method: 'ItemCache.retrieveObject.complete',
            params: [
                key
            ]
        });

        return item;
    }

    public async setObject(ref: I, item: T, expireIn: number = this.cacheExpireIn): Promise<void> {
        if (!this.cacheEnabled)
            return;

        let key = await this.getCacheKey(ref);

        ApplicationContext.logs.silly({
            method: 'ItemCache.setObject.start',
            params: [
                key,
                item
            ]
        });

        let itemRaw = await this.serialize(item) as Buffer;

        let pipeline = redis.pipeline();
        pipeline.setBuffer(key, itemRaw);
        if (expireIn > 0)
            pipeline.pexpire(key, expireIn);

        await pipeline.exec();

        ApplicationContext.logs.silly({
            method: 'ItemCache.setObject.complete',
            params: [
                key
            ]
        });

        return;
    }
}


export class DocumentItemCache<I, T, M extends Model<T&Document>> extends  ItemCache<I, T>{
    constructor(protected model: M, protected cacheExpireIn: number = config.cacheExpireIn) {
        super(
            model.modelName,
            cacheExpireIn
        );
    }

    public async getObject(ref: I): Promise<T&Document|null> {
        if (!this.cacheEnabled)
            return null;

        let item = await super.getObject(ref);

        if (!item) return null;

        return this.model.hydrate(item);
    }

    public async setObject(ref: I, item: T&Document, expireIn: number = this.cacheExpireIn): Promise<void> {
        if (!this.cacheEnabled)
            return;

        return super.setObject(ref, item.toJSON(), expireIn);
    }
}

export default ItemCache;