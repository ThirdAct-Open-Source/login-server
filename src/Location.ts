import {Mongoose, Schema, Document, Model} from 'mongoose';
import { ObjectId } from 'mongodb';
import * as url  from 'url';
import Config from './Config';
import mongoose from './Database';
import {ILocation as ILocationBase, IEntity, IDriverPut} from '@znetstar/attic-common/lib';
import {IDriver} from "@znetstar/attic-common/lib/IDriver";
import { LocationCopyDestinationMustHavePutError, CopyLocationsMustHaveDriverError } from "@znetstar/attic-common/lib/Error/Location";
import Constructible from "./Constructible";
import { RPCServer } from './RPC';
import { nanoid } from 'nanoid';
import {HTTPMirroredLocationMustHaveDriverError, HTTPMirroredRequestMustHaveResponseError} from "@znetstar/attic-common/lib/Error/Driver";
import * as _ from 'lodash';
import {
  BasicFindOptions,
  BasicFindQueryOptions,
  BasicTextSearchOptions,
  wrapPut,
  unwrapPut
} from "@znetstar/attic-common/lib/IRPC";
import {moveAndConvertValue, parseUUIDQueryMiddleware} from "./misc";
import {EntitySchema} from "./Entity";
import {checkScopePermission, IAccessToken} from "./Auth/AccessToken";
import {IHttpContext} from "./Drivers/HTTPCommon";
import {ScopeFormalAccessTokenPair} from "@znetstar/attic-common/lib/IAccessToken";
import {IDriverOfFull} from "@znetstar/attic-common";
const drivers = (<any>global).drivers = (<any>global).drivers || new Map<string, Constructible<IDriver>>();

type IUser = any;

export interface ILocationModel {
    id?: ObjectId;
    _id?: ObjectId;
    auth?: string[]|string;
    getHref?(): string;
    setHref?(value: string|url.UrlWithStringQuery): void;
    toString?(): string;
    getDriver?(): Constructible<IDriver>;
    entity?: IEntity|ObjectId;
    httpContext?: IHttpContext;
    driverOptions?: any;
    // @ts-ignore
    authenticateLocation?(user: IUser): Promise<boolean>;
    // @ts-ignore
    getUserByLocationAuth?(): AsyncGenerator<IUser&Document>;
    preferredAuthProvider?: string;
    copy?(...dest: (ILocation)[]): Promise<void>;
    slashes?: boolean;
}


export type ILocation = ILocationModel&ILocationBase;
export const LocationSchema = <Schema<ILocation>>(new (mongoose.Schema)({
    href: {
        type: String,
        required: true
    },
    protocol: {
        type: String,
        required: false
    },
    hostname: {
        type: String,
        required: false
    },
    host: {
        type: String,
        required: false
    },
    port: {
        type: String,
        required: false
    },
    pathname: {
        type: String,
        required: false
    },
    path: {
        type: String,
        required: false
    },
    auth: {
        type: [String],
        required: false
    },
    slashes: { type: Boolean, required: false },
    entity: {
        type: Schema.Types.ObjectId,
        ref: 'Entity'
    },
    hash: {
        type: String,
        required: false
    },
    search:  {
        type: String,
        required: false
    },
    driver: {
        type: String,
        required: false,
        enum: Config.drivers.slice(0)
    },
    expiresAt: {
        type: Date,
        required: false
    },
    driverOptions: {
        type: Schema.Types.Mixed,
        required: false
    },
    preferredAuthProvider: {
        type: String,
        required: false
    },
    cacheExpireIn: {
       type: Number,
      required: false,
      validate: (x: number) => x >= 0
    }
}, {
    timestamps: true,
    discriminatorKey: 'protocol'
}));

LocationSchema.virtual('httpContext')
    .get(function (){ return this.$locals.httpContext; })
    .set(function (ctx: IHttpContext){ this.$locals.httpContext = ctx; })

LocationSchema.index({
    'href': 'text',
    'driver': 'text',
    'path': 'text',
    'pathname': 'text',
    'host': 'text',
    'hostname': 'text',
    'protocol': 'text',
    hash: 'text',
}, {
    weights: {
        driver: 10,
        href: 10,
        protocol: 5,
        path: 4,
        pathname: 2,
        host: 4,
        hostname: 2,
        hash: 1
    },
    name: 'location_search'
});


LocationSchema.methods.getDriver = function () {
    return drivers.get(this.driver);
}


LocationSchema.methods.getHref = LocationSchema.methods.toString = function () {
    let clone = this.toJSON();
    let auth;
    if (clone.auth) {
        // clone.auth = [].concat(clone.auth).join(' ');
        delete clone.auth;
    }
    let href = url.format(clone);

    return href;
}

LocationSchema.methods.setHref = function (val: string|url.UrlWithStringQuery): void {
    if (typeof(val) === 'string')
        val = url.parse(val);

    if (val.auth) {
        let [auth] = val.auth.split(':');
        this.auth = auth.split(' ');

        delete val.auth;
    }

    for (let k in val) {
        if (k === 'auth' && _.isEmpty(val[k]))
            continue;
        if (['href', 'toString', 'id', '_id', 'auth'].includes((k)))
            continue;


      // @ts-ignore
        this[<any>k] = (<any>val)[<any>k];
    }

    this.href = url.format(val);
}

LocationSchema.pre(['save', 'init', 'create'] as any, function () {
    let self: ILocation&Document = <ILocation&Document>(this as any);
    if (self.href)
        LocationSchema.methods.setHref.call(self, self.href);
    self.href = LocationSchema.methods.getHref.call(self);
    // moveAndConvertValue(self, 'entity', 'entity', (x: any) => new ObjectId(x));
});

LocationSchema.pre([ 'find', 'findOne' ] as any, function () {
    let self: any = this;
    // moveAndConvertValue(self, 'entity', 'entity', (x: any) => new ObjectId(x));
});


// @ts-ignore
export async function authenticateLocation(location: ILocation, user: IUser): Promise<boolean> {
    let groups = [].concat(location.auth);

    if (!location.auth || !location.auth.length)
        return true;

    return groups.map(g => user.groups.includes(g)).includes(true);
}

// @ts-ignore
export async function* getUserByLocationAuth(location: ILocation): AsyncGenerator<IUser&Document> {

    // @ts-ignore
    let cur = User.find({ groups: { $in: location.auth } }).cursor();

    let doc;
    while (doc = await cur.next()) {
        yield doc;
    }
}

LocationSchema.methods.authenticateLocation = async function (user: IUser) {
    return authenticateLocation(this, user);
}

LocationSchema.methods.getUserByLocationAuth = async function* (): AsyncGenerator<IUser&Document> {
    return getUserByLocationAuth(this);
}


LocationSchema.methods.copy = async function (...dest: ILocation[])  {
  const drivers = [this.driver ||null, ...dest.map((d) => d.driver || null)];

  if (drivers.includes(null))
    throw new CopyLocationsMustHaveDriverError();

  await this.populate('entity').execPopulate();

  const source: IDriver = new (this.getDriver())();
  const b = await source.get(this);

  await Promise.all<void>(dest.map(async (destLocBase) => {
    const destLoc: ILocation&Document = Location.hydrate(destLocBase);

    destLoc.$locals.httpContext = this.$locals.httpContext;

    const destDriver: IDriverPut<unknown, unknown, unknown>  = new (destLoc.getDriver())() as IDriverOfFull<unknown,unknown,unknown>&IDriverPut<unknown, unknown,unknown>;
    await destLoc.populate('entity').execPopulate();

    // @ts-ignore
    const body = wrapPut({ data: b.body }, destLoc.$locals.httpContext);

    await destDriver.put(
      destLoc, body
    );
  }))
}

RPCServer.methods.copyLocation = async function (source: string, ...dest: string[]): Promise<void> {
  const locations = await Promise.all([
    Location.findById(source).populate('entity').exec(),
    ...dest.map((m) => Location.findById(m).populate('entity').exec())
  ]);

  let { req, res } = (this as any).context.clientRequest.additionalData;
  for (const loc of locations) {
    loc.$locals.httpContext = { req, res, scopeContext: req.scopeContext };
  }

  await locations[0].copy(...locations.slice(1));
}

RPCServer.methods.authenticateLocation = async (locationId: string, userId: string): Promise<boolean> => {
    let [ location, user ] = await Promise.all([
        Location.findById(locationId).exec(),

        // @ts-ignore
        User.findById(userId).exec()
    ]);

    return authenticateLocation(location, user);
}

RPCServer.methods.getUserByLocationAuth = async (locationId: string): Promise<IUser[]> => {
    let [ location ] = await Promise.all([
        Location.findById(locationId).exec()
    ]);

    let results: IUser[] = [];
    for await (let user of getUserByLocationAuth(location)) {
        results.push(user.toJSON());
    }

    return results;
}

RPCServer.methods.findLocation = async (query: any) => {
    let location = await Location.findOne(query).exec();
    return location ? location.toJSON({ virtuals: true }) : void(0);
}

export async function findLocationInner(query: BasicFindOptions) {
    let locationsQuery = (Location.find(query.query));
    if (query.count) {
        const count = await locationsQuery.count().exec();
        return count;
    }
    if (query.sort) locationsQuery.sort(query.sort);
    if (!Number.isNaN(Number(query.skip))) locationsQuery.skip(query.skip);
    if (!Number.isNaN(Number(query.limit))) locationsQuery.limit(query.limit);
if (query.populate) locationsQuery.populate(query.populate);
    let locations = await locationsQuery.exec();
    return locations;
}

RPCServer.methods.findLocations = async (query: BasicFindOptions) => {
    let locations = await findLocationInner(query);
    return Array.isArray(locations) ?
        locations.map(l => l.toJSON({ virtuals: true })) :
        locations;
}

RPCServer.methods.createLocation = async (fields: any) => {
    if (fields.entity)
        fields.entity = new ObjectId(fields.entity);
    let location = new Location(fields);
    await location.save();

    return {
        id: location.id,
        href: location.href
    };
}

RPCServer.methods.deleteLocation = async (query: any) => {
    await RPCServer.methods.deleteLocations({ limit: 1, query })
}

RPCServer.methods.deleteLocations = async (query: BasicFindQueryOptions) => {
    let locs: Array<ILocation&Document> = (await findLocationInner(query)) as Array<ILocation&Document>;
    for (let loc of locs) {
        await loc.remove();
    }
}

RPCServer.methods.updateLocation = async (id: string, fields: any) => {
    let doc = await Location.findOne({ _id: new ObjectId(id) });

    _.extend(doc, fields);
    await doc.save();

    return {
        id: doc.id,
        href: doc.href
    }
}

RPCServer.methods.searchLocations = async (query:  BasicTextSearchOptions) => {
    let locationsQuery = (Location.find({
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
        const count = await locationsQuery.count().exec();
        return count;
    }
    if (!Number.isNaN(Number(query.skip))) locationsQuery.skip(query.skip);
    if (!Number.isNaN(Number(query.limit))) locationsQuery.limit(query.limit);
if (query.populate) locationsQuery.populate(query.populate);
    let locations = await locationsQuery.exec();
    return locations.map(l => l.toJSON({ virtuals: true }));
}

export const Location = mongoose.model<ILocation&Document>('Location', LocationSchema);

Location.collection.createIndex({ 'href': 1 }, { unique: true });

Location.collection.createIndex({
    '_id': 1,
    'driver': -1
}, {
    unique: true
});

Location.collection.createIndex({
    expiresAt: 1
}, {
    expireAfterSeconds: 0
});



export default Location;
