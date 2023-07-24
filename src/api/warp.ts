import {
  EvalStateResult,
  EvaluationManifest,
  EvaluationOptions,
  Warp,
} from 'warp-contracts';
import { EVALUATION_TIMEOUT_MS, allowedContractTypes } from '../constants';
import { ContractType } from '../types';
import * as _ from 'lodash';
import { EvaluationTimeoutError } from '../errors';
import { createHash } from 'crypto';
import Arweave from 'arweave';
const requestMap: Map<string, Promise<any> | undefined> = new Map();

export const DEFAULT_EVALUATION_OPTIONS: Partial<EvaluationOptions> = {};

function createQueryParamHash(evalOptions: Partial<EvaluationOptions>): string {
  // Function to calculate the hash of a string
  const hash = createHash('sha256');
  hash.update(JSON.stringify(evalOptions));
  return hash.digest('hex');
}

export class EvaluationError extends Error {
  constructor(message?: string) {
    super(message);
  }
}

// TODO: we can put this in a interface/class and update the resolved type
export async function getContractState({
  id,
  warp,
  evaluationOptions = DEFAULT_EVALUATION_OPTIONS,
}: {
  id: string;
  warp: Warp;
  evaluationOptions?: Partial<EvaluationOptions>;
}): Promise<EvalStateResult<any>> {
  try {
    // get the contract manifest eval options by default
    const { evaluationOptions: contractDefinedEvalOptions } =
      await getContractManifest({ id, arweave: warp.arweave });
    // override any contract manifest eval options with eval options provided
    const combinedEvalOptions = {
      ...contractDefinedEvalOptions,
      ...evaluationOptions,
    };
    const evaluationOptionsHash = createQueryParamHash(combinedEvalOptions);
    const cacheId = `${id}-${evaluationOptionsHash}`;
    // validate request is new, if not return the existing promise (e.g. barrier synchronization)
    if (requestMap.get(cacheId)) {
      const { cachedValue } = await requestMap.get(cacheId);
      return cachedValue;
    }
    // use the combined evaluation options
    const contract = warp
      .contract(id)
      .setEvaluationOptions(combinedEvalOptions);
    // set cached value for multiple requests during initial promise
    requestMap.set(cacheId, contract.readState());
    // await the response
    const { cachedValue } = await requestMap.get(cacheId);
    // remove the cached value once it's been retrieved
    requestMap.delete(cacheId);
    return cachedValue;
  } catch (error) {
    // throw an eval here so we can properly return correct status code
    if (
      error instanceof Error &&
      // reference: https://github.com/warp-contracts/warp/blob/92e3ec4bffdea27abb791c38b77a115d7c8bd8f5/src/contract/EvaluationOptionsEvaluator.ts#L134-L162
      (error.message.includes('Cannot proceed with contract evaluation') ||
        error.message.includes('Use contract.setEvaluationOptions'))
    ) {
      throw new EvaluationError(error.message);
    }
    throw error;
  }
}

export async function getContractManifest({
  id,
  arweave,
}: {
  id: string;
  arweave: Arweave;
  evaluationOptions?: Partial<EvaluationOptions>;
}): Promise<EvaluationManifest> {
  const { data: encodedTags } = await arweave.api.get(`/tx/${id}/tags`);
  const decodedTags = tagsToObject(encodedTags);
  // this may not exist, so provided empty json object string as default
  const contractManifestString = decodedTags['Contract-Manifest'] ?? '{}';
  const contractManifest = JSON.parse(contractManifestString);
  return contractManifest;
}

export function tagsToObject(tags: { name: string; value: string }[]): {
  [x: string]: string;
} {
  return tags.reduce(
    (newTags, tag) => ({
      ...newTags,
      [fromB64Url(tag.name)]: fromB64Url(tag.value),
    }),
    {},
  );
}

export async function validateStateWithTimeout(
  id: string,
  warp: Warp,
  type?: ContractType,
  address?: string,
  evaluationOptions: Partial<EvaluationOptions> = DEFAULT_EVALUATION_OPTIONS,
): Promise<unknown> {
  return Promise.race([
    validateStateAndOwnership(id, warp, type, address, evaluationOptions),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new EvaluationTimeoutError()),
        EVALUATION_TIMEOUT_MS,
      ),
    ),
  ]);
}

// TODO: this could be come a generic and return the full state of contract once validated
export async function validateStateAndOwnership(
  id: string,
  warp: Warp,
  type?: ContractType,
  address?: string,
  evaluationOptions: Partial<EvaluationOptions> = DEFAULT_EVALUATION_OPTIONS,
): Promise<boolean> {
  const { state } = await getContractState({ id, warp, evaluationOptions });
  // TODO: use json schema validation schema logic. For now, these are just raw checks.
  const validateType =
    !type ||
    (type && type === 'ant' && state['records'] && state['records']['@']);
  const validateOwnership =
    !address ||
    (address && state['owner'] === address) ||
    state['controller'] === address;
  return validateType && validateOwnership;
}

// validates that a provided query param is of a specific value
export function isValidContractType(
  type: string | string[] | undefined,
): type is ContractType {
  if (type instanceof Array) {
    return false;
  }

  return !type || (!!type && _.includes(allowedContractTypes, type));
}

export function fromB64Url(input: string): string {
  const decodedBuffer = Buffer.from(input, 'base64');
  return decodedBuffer.toString();
}
