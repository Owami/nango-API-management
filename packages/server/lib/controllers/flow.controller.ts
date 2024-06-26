import type { Request, Response, NextFunction } from 'express';
import { getUserAccountAndEnvironmentFromSession } from '../utils/utils.js';
import type { IncomingPreBuiltFlowConfig, FlowDownloadBody } from '@nangohq/shared';
import {
    flowService,
    accountService,
    connectionService,
    getEnvironmentAndAccountId,
    errorManager,
    configService,
    deployPreBuilt as deployPreBuiltSyncConfig,
    syncOrchestrator,
    remoteFileService,
    getAllSyncsAndActions,
    getNangoConfigIdAndLocationFromId,
    getConfigWithEndpointsByProviderConfigKeyAndName,
    getSyncsByConnectionIdsAndEnvironmentIdAndSyncName,
    enableScriptConfig as enableConfig,
    disableScriptConfig as disableConfig
} from '@nangohq/shared';
import { logContextGetter } from '@nangohq/logs';

class FlowController {
    public async getFlows(req: Request, res: Response, next: NextFunction) {
        try {
            const { success, error, response } = await getUserAccountAndEnvironmentFromSession(req);

            if (!success || response === null) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }
            const availableFlows = flowService.getAllAvailableFlows();
            const addedFlows = await flowService.getAddedPublicFlows(response.environment.id);

            res.send({ addedFlows, availableFlows });
        } catch (e) {
            next(e);
        }
    }

    public async adminDeployPrivateFlow(req: Request, res: Response, next: NextFunction) {
        try {
            const { success, error, response } = await getEnvironmentAndAccountId(res, req);

            if (!success || response === null) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const { targetAccountUUID, targetEnvironment, config } = req.body;

            const result = await accountService.getAccountAndEnvironmentIdByUUID(targetAccountUUID, targetEnvironment);

            if (!result) {
                res.status(400).send('Invalid environment');
                return;
            }

            const { environmentId } = result;

            const {
                success: preBuiltSuccess,
                error: preBuiltError,
                response: preBuiltResponse
            } = await deployPreBuiltSyncConfig(environmentId, config, req.body.nangoYamlBody || '', logContextGetter);

            if (!preBuiltSuccess || preBuiltResponse === null) {
                errorManager.errResFromNangoErr(res, preBuiltError);
                return;
            }

            await syncOrchestrator.triggerIfConnectionsExist(preBuiltResponse.result, environmentId, logContextGetter);

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async deployPreBuiltFlow(req: Request, res: Response, next: NextFunction) {
        try {
            const { success, error, response } = await getEnvironmentAndAccountId(res, req);

            if (!success || response === null) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const config: IncomingPreBuiltFlowConfig[] = req.body;

            if (!config) {
                res.status(400).send('Missing config');
                return;
            }

            if (config.some((c) => !c.provider)) {
                res.status(400).send('Missing integration');
                return;
            }

            const { environmentId, accountId } = response;

            // config is an array for compatibility purposes, it will only ever have one item
            const [firstConfig] = config;
            let providerLookup;
            if (firstConfig?.providerConfigKey) {
                providerLookup = await configService.getConfigIdByProviderConfigKey(firstConfig?.providerConfigKey, environmentId);
            } else {
                providerLookup = await configService.getConfigIdByProvider(firstConfig?.provider as string, environmentId);
            }

            if (!providerLookup) {
                errorManager.errRes(res, 'provider_not_on_account');
                return;
            }

            const account = await accountService.getAccountById(accountId);

            if (!account) {
                errorManager.errRes(res, 'unknown_account');
                return;
            }

            if (account.is_capped && firstConfig?.providerConfigKey) {
                const isCapped = await connectionService.shouldCapUsage({ providerConfigKey: firstConfig?.providerConfigKey, environmentId });

                if (isCapped) {
                    errorManager.errRes(res, 'resource_capped');
                    return;
                }
            }

            const {
                success: preBuiltSuccess,
                error: preBuiltError,
                response: preBuiltResponse
            } = await deployPreBuiltSyncConfig(environmentId, config, '', logContextGetter);

            if (!preBuiltSuccess || preBuiltResponse === null) {
                errorManager.errResFromNangoErr(res, preBuiltError);
                return;
            }

            await syncOrchestrator.triggerIfConnectionsExist(preBuiltResponse.result, environmentId, logContextGetter);

            res.status(201).send(preBuiltResponse.result);
        } catch (e) {
            next(e);
        }
    }

    public async downloadFlow(req: Request, res: Response, next: NextFunction) {
        try {
            const { success, error, response } = await getEnvironmentAndAccountId(res, req);

            if (!success || response === null) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const { environmentId, accountId } = response;

            const body: FlowDownloadBody = req.body as FlowDownloadBody;

            if (!body) {
                res.status(400).send('Missing body');
                return;
            }

            const { id, name, provider, is_public, providerConfigKey, flowType } = body;

            if (!name || !provider || typeof is_public === 'undefined') {
                res.status(400).send('Missing required fields');
                return;
            }

            if (!id && is_public) {
                await remoteFileService.zipAndSendPublicFiles(res, name, accountId, environmentId, body.public_route as string);
                return;
            } else {
                // it has an id, so it's either a public template that is active, or a private template
                // either way, we need to fetch it from the users directory in s3
                const configLookupResult = await getNangoConfigIdAndLocationFromId(id as number);

                if (!configLookupResult) {
                    res.status(400).send('Invalid file reference');
                    return;
                }

                const { nango_config_id, file_location } = configLookupResult;
                await remoteFileService.zipAndSendFiles(res, name, accountId, environmentId, nango_config_id, file_location, providerConfigKey, flowType);
                return;
            }
        } catch (e) {
            next(e);
        }
    }

    public async getFlowConfig(req: Request, res: Response, next: NextFunction) {
        try {
            const { success, error, response } = await getEnvironmentAndAccountId(res, req);

            if (!success || response === null) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const { environmentId } = response;

            const nangoConfigs = await getAllSyncsAndActions(environmentId);

            res.send(nangoConfigs);
        } catch (e) {
            next(e);
        }
    }

    public async enableFlow(req: Request, res: Response, next: NextFunction) {
        try {
            const { success, error, response } = await getEnvironmentAndAccountId(res, req);

            if (!success || response === null) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const { environmentId } = response;

            const id = req.params['id'];
            const flow = req.body;

            if (!id) {
                res.status(400).send('Missing id');
                return;
            }

            await enableConfig(Number(id));

            await syncOrchestrator.triggerIfConnectionsExist([flow], environmentId, logContextGetter);

            res.status(200).send([{ ...flow, enabled: true }]);
        } catch (e) {
            next(e);
        }
    }

    public async disableFlow(req: Request, res: Response, next: NextFunction) {
        try {
            const { success, error, response } = await getEnvironmentAndAccountId(res, req);

            if (!success || response === null) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const { environmentId } = response;

            const id = req.params['id'];
            const connectionIds = req.query['connectionIds'] as string;
            const syncName = req.query['sync_name'] as string;
            const flow = req.body;

            if (!id) {
                res.status(400).send('Missing id');
                return;
            }

            if (!syncName) {
                res.status(400).send('Missing sync_name');
                return;
            }

            if (connectionIds) {
                const connections = connectionIds.split(',');

                const syncs = await getSyncsByConnectionIdsAndEnvironmentIdAndSyncName(connections, environmentId, syncName);

                for (const sync of syncs) {
                    await syncOrchestrator.softDeleteSync(sync.id, environmentId);
                }
            }

            await disableConfig(Number(id));

            res.send({ ...flow, enabled: false });
        } catch (e) {
            next(e);
        }
    }

    public async getFlow(req: Request, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);
            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }

            const { environment } = response;
            const providerConfigKey = req.query['provider_config_key'] as string;
            const { flowName } = req.params;

            if (!providerConfigKey) {
                res.status(400).send({ message: 'Missing provider config key' });
                return;
            }

            if (!flowName) {
                res.status(400).send({ message: 'Missing sync name' });
                return;
            }

            const flow = flowService.getSingleFlowAsStandardConfig(flowName);
            const provider = await configService.getProviderName(providerConfigKey);
            const flowConfig = await getConfigWithEndpointsByProviderConfigKeyAndName(environment.id, providerConfigKey, flowName);

            res.send({ flowConfig, unEnabledFlow: flow, provider });
        } catch (e) {
            next(e);
        }
    }
}

export default new FlowController();
