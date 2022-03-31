export function asyncMiddleware(fn: Function) {
    return (req: any, res: any, next: any) => {
        const p = <Promise<any>>fn(req, res);

        p.then((result) => {
            if (typeof(result) !== 'undefined')
                next(result === true ? void(0) : result);
        }, (err) => {
            err.url = req.url;
            next(err);
        });
    }
}   