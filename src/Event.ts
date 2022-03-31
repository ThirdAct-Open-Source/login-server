import Location, {ILocation, LocationSchema} from './Location';
import { IEvent as IEventBase } from '@znetstar/attic-common/lib';
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
import {CannotModifyOrDeleteEventError} from "@znetstar/attic-common/lib/Error";
import ApplicationContext from "./ApplicationContext";

export interface IEventModel {
  id: ObjectId;
  _id: ObjectId;
}

export type IEvent = IEventModel&IEventBase<any>;

export const EventSchema = <Schema<IEvent>>new (mongoose.Schema)({
  type: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    required: true,
    default: () => new Date()
  },
  subject: {
    type: Schema.Types.Mixed,
    required: false
  },
  description: {
    type: String,
    required: false
  },
  meta: {
    type: Schema.Types.Mixed,
    required: false
  }
}, {
  discriminatorKey: 'type',
  timestamps: false,
  capped: {
    autoIndexId: true,
    size: config.eventsCollectionSize
  }
});

EventSchema.pre<IEvent&Document>('save',async function () {
  if (typeof(this.subject) === 'object' && this.subject !== null) {
    this.subject = require('mongo-sanitize')(this.subject);
  }
  if (typeof(this.meta) === 'object' && this.meta !== null) {
    this.meta = require('mongo-sanitize')(this.meta);
  }
  if (this.isNew) {
   await ApplicationContext.triggerHook(`events.${this.type}`, this);
  }
});

RPCServer.methods.findEvent = async (query: any) => {
  if (query.id  || query._id) {
    query._id = new ObjectId((query.id  || query._id))
    delete  query.id;
  }
  let event = await Event.findOne(query).exec();
  return event ? event.toJSON({ virtuals: true }) : void(0);
}

export async function findEventInner(query: BasicFindOptions) {
  let EventQuery = (Event.find(query.query));
  if (query.count) {
    const count = await EventQuery.count().exec();
    return count;
  }

  if (query.sort) EventQuery.sort(query.sort);
  if (!Number.isNaN(Number(query.skip))) EventQuery.skip(query.skip);
  if (!Number.isNaN(Number(query.limit))) EventQuery.limit(query.limit);
  if (query.populate) EventQuery.populate(query.populate);
  let events = await EventQuery.exec();
  return events;
}

RPCServer.methods.findEvents = async (query: BasicFindOptions) => {
  let events = await findEventInner(query);
  return Array.isArray(events) ?
    events.map(e => e.toJSON({ virtuals: true })) :
    events;
}

RPCServer.methods.createEvent = async (type: string, event: Partial<IEventBase<unknown>>): Promise<string> => {
  const ev = await ApplicationContext.createEvent(type, event);
  return ev._id.toString();
}


const Event = mongoose.model<IEvent&Document>('Event', EventSchema);
export default Event;
