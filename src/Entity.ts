import Location, {ILocation, LocationSchema} from './Location';
import { IEntity as IEntityBase } from '@znetstar/attic-common/lib';
import { Stream } from 'stream';
import { Mongoose, Schema, Document } from 'mongoose';
import config from './Config';
import mongoose from './Database';
import { ObjectId } from 'mongodb';
import {RPCServer} from "./RPC";
import {BasicFindOptions, BasicFindQueryOptions, BasicTextSearchOptions} from "@znetstar/attic-common/lib/IRPC";
import * as _ from "lodash";
import { moveAndConvertValue } from "./misc";
import {userFromRpcContext} from "./User";
import {FindEntitiesResult} from "@znetstar/attic-common/lib/IRPC";

export interface IEntityModel {
    id: ObjectId;
    _id: ObjectId;
    source: ILocation;
}

export type IEntity = IEntityModel&IEntityBase;

export const EntitySchema = <Schema<IEntity>>new (mongoose.Schema)({
    source: {
      type: LocationSchema,
      unique: true,
      required: true
    },
    type: {
      type: String,
      required: true,
      enum: config.entityTypes.slice(0)
    }
}, {
    discriminatorKey: 'type',
    timestamps: true
});



EntitySchema.pre(([ 'find', 'findOne' ] as  any),  function () {
    let self = this as any;

    moveAndConvertValue(self, '_conditions.source', '_conditions.source.href');
})

EntitySchema.index({
    "$**": "text"
}, {
    weights: {
        type: 10,
        'source.href': 10,
        'source.protocol': 2,
        'source.path': 2,
        'source.pathname': 1,
        'source.host': 2,
        'source.hostname': 1,
        'source.hash': 1
    },
    name: 'entity_search'
});


RPCServer.methods.findEntity = async (query: any) => {
    if (query.id  || query._id) {
      query._id = new ObjectId((query.id  || query._id))
      delete  query.id;
    }
    let entity = await Entity.findOne(query).exec();
    return entity ? entity.toJSON({ virtuals: true }) : void(0);
}

export async function findEntityInner(query: BasicFindOptions) {
    let entityQuery = (Entity.find(query.query));
    if (query.count) {
        const count = await entityQuery.count().exec();
        return count;
    }

    if (query.sort) entityQuery.sort(query.sort);
    if (!Number.isNaN(Number(query.skip))) entityQuery.skip(query.skip);
    if (!Number.isNaN(Number(query.limit))) entityQuery.limit(query.limit);
if (query.populate) entityQuery.populate(query.populate);
    let entities = await entityQuery.exec();
    return entities;
}

RPCServer.methods.findEntities = async (query: BasicFindOptions) => {
    let entities = await findEntityInner(query);
    return Array.isArray(entities) ?
        entities.map(e => e.toJSON({ virtuals: true })) :
        entities;
}

RPCServer.methods.findSelfEntities = async (query: BasicFindOptions): Promise<FindEntitiesResult> => {
    let { user } = userFromRpcContext(this);

    query.query.user = user._id;

    let entities = await findEntityInner(query);
    return Array.isArray(entities) ?
        entities.map(e => e.toJSON({ virtuals: true })) :
        entities;
}

RPCServer.methods.createEntity = async (fields: any) => {
    let entity = await Entity.create(fields);

    return entity.id;
}


RPCServer.methods.deleteEntity = async (query: any) => {
    await RPCServer.methods.deleteEntities({ limit: 1, query })
}

RPCServer.methods.deleteEntities = async (query: BasicFindQueryOptions) => {
    let ents: Array<IEntity&Document> = (await findEntityInner(query)) as Array<IEntity&Document>;
    for (let ent of ents) {
        await ent.remove();
    }

}

RPCServer.methods.deleteSelfEntities = async (query: BasicFindQueryOptions) => {
    let { user } = userFromRpcContext(this);

    query.query.user = user._id;

    let ents: Array<IEntity&Document> = (await findEntityInner(query)) as Array<IEntity&Document>;
    for (let ent of ents) {
        await ent.remove();
    }
}

RPCServer.methods.updateEntity = async (id: string, fields: any) => {
    let doc = await Location.findOne({ _id: new ObjectId(id) });

    _.extend(doc, fields);
    await doc.save();
}

RPCServer.methods.searchEntities = async (query:  BasicTextSearchOptions) => {
    let entityQuery = (Location.find({
        $text: {
            $search: query.terms,
            $caseSensitive: false
        }
    }, {
        score: {
            $meta: 'textScore'
        }
    }).sort({ score:{ $meta:"textScore" }} ));
    if (query.count) {
        const count = await entityQuery.count().exec();
        return count;
    }
    if (!Number.isNaN(Number(query.skip))) entityQuery.skip(query.skip);
    if (!Number.isNaN(Number(query.limit))) entityQuery.limit(query.limit);
if (query.populate) entityQuery.populate(query.populate);
    let ents = await entityQuery.exec();

  // @ts-ignore
    return ents.map(e => e.toJSON({ virtuals: true })) as IEntity[];
}


const Entity = mongoose.model<IEntity&Document>('Entity', EntitySchema);
export default Entity;
