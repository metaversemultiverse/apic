import { Injectable } from "@angular/core";
import LocalStore from "./localStore";
import { Utils } from "./utils.service";
import iDB from './IndexedDB';
import { RequestsService } from "./requests.service";
import { ApiProjectService } from "./apiProject.service";
import { ApiEndp, ApiProject, ApiResponse, EndpBody } from "../models/ApiProject.model";
import { METHOD_WITH_BODY } from "../utils/constants";

@Injectable()
export class MigrationService {
    migrations = [{
        name: 'Project endpoints: Modify response to support OAS3',
        conditions: [{
            on: 'oldVersion',
            check: 'isVersionLower',
            value: '3.1.1'
        }],
        action: async () => {
            //migrate to OAS3 response and body type
            let allProjects: ApiProject[] = await iDB.read(iDB.TABLES.API_PROJECTS);
            let migrated: ApiProject[] = allProjects
                .map(proj => {
                    proj.endpoints = Utils.objectValues(proj.endpoints).map(endpoint => {
                        let { produces, consumes, responses, body, ...rest } = endpoint as any;
                        //update responses
                        if (!produces || produces?.length === 0) {
                            produces = ['application/json']
                        }
                        let updatedResponses: ApiResponse[];
                        if (endpoint.hasOwnProperty('produces')) {
                            console.log('Updating endpoint response.');
                            updatedResponses = this.migrations[0].transform(responses, produces);
                        } else {
                            //response is already updated
                            console.log('Endpoint response already updated. ');
                            updatedResponses = responses;
                        }

                        //update body
                        if (!consumes || consumes?.length === 0) {
                            consumes = ['application/json']
                        }
                        let updatedBody: EndpBody = body;
                        if (METHOD_WITH_BODY.includes(endpoint.method.toUpperCase())) {
                            if (body.hasOwnProperty('type')) {//old endpoint
                                console.log('Updating endp body.');
                                if (body.type === 'form-data') {
                                    consumes = ['multipart/form-data']
                                }
                                if (body.type === 'x-www-form-urlencoded') {
                                    consumes = ['application/x-www-form-urlencoded']
                                }
                                updatedBody = {
                                    data: consumes.map(c => {
                                        return { schema: body.data, mime: c, examples: [] }
                                    }),
                                    desc: ''
                                }
                            } else {
                                console.log('Endpoint body already updated.');
                            }
                        }
                        return {
                            ...rest,
                            responses: updatedResponses,
                            ...(METHOD_WITH_BODY.includes(endpoint.method.toUpperCase()) && { body: updatedBody })
                        } as ApiEndp;
                    }).reduce((obj, f) => {
                        const key = f._id; return ({ ...obj, [key]: f })
                    }, {})

                    //update trait
                    proj.traits = Utils.objectValues(proj.traits).map(trait => {
                        let { responses, ...rest } = trait as any;
                        let updatedResponses: ApiResponse[];
                        if (!(responses[0]?.data instanceof Array)) {
                            console.log('Updating trait response. ');
                            updatedResponses = this.migrations[0].transform(responses, ['application/json']);
                        } else {
                            //response is already updated
                            console.log('Trait response already updated.');
                            updatedResponses = responses;
                        }

                        return { ...rest, responses: updatedResponses } as ApiEndp;
                    }).reduce((obj, f) => {
                        const key = f._id; return ({ ...obj, [key]: f })
                    }, {})
                    return proj;
                });

            await Promise.all(migrated.map(async (proj) => {
                await this.apiProjectService.updateAPIProject(proj);
            }));

            //migrate saved request responses to OAS3
        },

        transform: (responses, produces) => {
            return responses.map(oldResp => {
                let { data, examples, ...restOfResponse } = oldResp;
                return {
                    ...restOfResponse,
                    data: produces.map(mime => {
                        return {
                            mime,
                            schema: data,
                            examples: examples || []
                        }
                    }),
                    headers: { type: 'object', properties: {}, required: [] }
                }
            })
        }
    }];
    newVersion: string;
    oldVersion: string;

    constructor(private apiProjectService: ApiProjectService) { }

    async migrate(newVesrion: string, oldVersion: string) {
        this.newVersion = newVesrion;
        this.oldVersion = oldVersion || '0.0.0';
        console.debug('Migrating');
        let migrations = [], promises = [];

        this.migrations.forEach(m => {
            console.debug(`Running migration: ${m.name}`);

            let conditions = m.conditions;
            let isApplicable = conditions.map(c => {
                return MigrationService[c.check].call(this, this[c.on], c.value)
            }).every(e => e);
            if (isApplicable) {
                migrations.push(m.action);
            }
        });

        migrations.forEach(action => {
            promises.push(action.call(this, newVesrion, oldVersion));
        })

        await Promise.all(promises);
        console.debug('Migration completed');

        this.onDone(newVesrion, this.oldVersion);
    }

    onDone(newVesrion: string, oldVersion: string) {
        if (this.oldVersion && MigrationService.isVersionHigher(newVesrion, oldVersion)) {
            Utils.notify('APIC Updated', 'Apic has been updated to a new version (' + newVesrion + ').', 'https://apic.app/changelog.html');
        }
        LocalStore.set(LocalStore.VERSION, newVesrion);
    }

    static isVersionEqual(version: string, toCompare: string): boolean {
        return version === toCompare;
    }

    static isVersionLower(version: string, toCompare: string): boolean {
        if (!version) return false;
        var v1parts = version.split('.').map(Number),
            v2parts = toCompare.split('.').map(Number);

        for (var i = 0; i < v1parts.length; ++i) {
            if (v2parts.length == i) {
                return false;
            }

            if (v1parts[i] == v2parts[i]) {
                continue;
            }
            else if (v1parts[i] > v2parts[i]) {
                return false;
            }
            else {
                return true;
            }
        }

        if (v1parts.length != v2parts.length) {
            return true;
        }

        return false;
    }

    static isVersionHigher(version: string, toCompare: string): boolean {
        return !this.isVersionEqual(version, toCompare) && !this.isVersionLower(version, toCompare);
    }
}
