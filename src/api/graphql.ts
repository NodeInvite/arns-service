/**
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import Arweave from 'arweave';
import { ArNSInteraction } from '../types.js';
import {
  GQLResultInterface,
  LexicographicalInteractionsSorter,
  TagsParser,
} from 'warp-contracts';
import logger from '../logger';

export const MAX_REQUEST_SIZE = 100;

export async function getDeployedContractsByWallet(
  arweave: Arweave,
  params: { address: string },
): Promise<{ ids: string[] }> {
  const { address } = params;
  let hasNextPage = false;
  let cursor: string | undefined;
  const ids = new Set<string>();
  do {
    const queryObject = {
      query: `
      { 
          transactions (
              owners:["${address}"]
              tags:[
                {
                  name: "App-Name",
                  values: ["SmartWeaveContract"]
                },
              ],
              sort: HEIGHT_DESC,
              first: ${MAX_REQUEST_SIZE},
              bundledIn: null,
              ${cursor ? `after: "${cursor}"` : ''}
          ) {
              pageInfo {
                  hasNextPage
              }
              edges {
                  cursor
                  node {
                      id
                      block {
                          height
                      }
                  }
              }
          }
      }`,
    };

    const { status, ...response } = await arweave.api.post(
      '/graphql',
      queryObject,
    );
    if (status !== 200) {
      throw Error(
        `Failed to fetch contracts for wallet. Status code: ${status}`,
      );
    }

    if (!response.data.data?.transactions?.edges?.length) {
      continue;
    }
    response.data.data.transactions.edges
      .map(
        (e: {
          cursor: string;
          node: { id: string };
          pageInfo?: { hasNextPage: boolean };
        }) => ({
          id: e.node.id,
          cursor: e.cursor,
          hasNextPage: e.pageInfo?.hasNextPage,
        }),
      )
      .forEach((c: { id: string; cursor: string; hasNextPage: boolean }) => {
        ids.add(c.id);
        cursor = c.cursor;
        hasNextPage = c.hasNextPage ?? false;
      });
  } while (hasNextPage);

  return {
    ids: [...ids],
  };
}

export async function getWalletInteractionsForContract(
  arweave: Arweave,
  params: {
    address?: string | undefined;
    contractTxId: string;
    blockHeight: number | undefined;
  },
): Promise<{
  interactions: Map<
    string,
    Omit<ArNSInteraction, 'valid' | 'errorMessage' | 'id'>
  >;
}> {
  const parser = new TagsParser();
  const interactionSorter = new LexicographicalInteractionsSorter(arweave);
  const { address, contractTxId, blockHeight: blockHeightFilter } = params;
  let hasNextPage = false;
  let cursor: string | undefined;
  const interactions = new Map<
    string,
    Omit<ArNSInteraction, 'valid' | 'errorMessage' | 'id'>
  >();
  do {
    const ownerFilter = address ? `owners: ["${address}"]` : '';
    const queryObject = {
      query: `
        { 
            transactions (
                ${ownerFilter}
                tags:[
                    {
                        name: "App-Name"
                        values: ["SmartWeaveAction"]
                    }
                    {
                        name:"Contract"
                        values:["${contractTxId}"]
                    }
                ],
                block: {
                  min: 0
                  max: ${blockHeightFilter ?? null}
                }
                first: ${MAX_REQUEST_SIZE}
                sort: HEIGHT_DESC
                bundledIn: null
                ${cursor ? `after: "${cursor}"` : ''}
            ) {
                pageInfo {
                    hasNextPage
                }
                edges {
                    cursor
                    node {
                        id
                        owner {
                          address
                        }
                        tags {
                            name
                            value
                        }
                        block {
                            id
                            height
                            timestamp
                        }
                    }
                }
            }
        }`,
    };

    const { status, data } = await arweave.api.post<GQLResultInterface>(
      '/graphql',
      queryObject,
    );

    if (status !== 200) {
      throw Error(
        `Failed to fetch contracts for wallet. Status code: ${status}`,
      );
    }

    if (!data.data.transactions?.edges?.length) {
      continue;
    }

    // remove interactions without block data
    let validInteractions = data.data.transactions.edges.filter(
      (i) => i.node.block && i.node.block.height && i.node.block.id,
    );
    // sort them using warps sort logic and add sort keys
    validInteractions = await interactionSorter.sort(validInteractions);

    for (const i of validInteractions) {
      // basic validation for smartweave tags
      const inputTag = parser.getInputTag(i.node, contractTxId);
      const contractTag = parser.getContractTag(i.node);

      if (!inputTag || !contractTag) {
        logger.debug('Invalid tags for interaction via GQL, ignoring...', {
          contractTxId,
          interactionId: i.node.id,
          inputTag,
          contractTag,
        });
        continue;
      }
      const parsedInput = inputTag?.value
        ? JSON.parse(inputTag.value)
        : undefined;
      interactions.set(i.node.id, {
        height: i.node.block.height,
        timestamp: i.node.block.timestamp,
        input: parsedInput,
        owner: i.node.owner.address,
        sortKey:
          // we should already have a sort key from warp, but if not, generate one
          i.node.sortKey ??
          (await interactionSorter.createSortKey(
            i.node.block.id,
            i.node.id,
            i.node.block.height,
          )),
      });
    }
    cursor =
      data.data.transactions.edges[MAX_REQUEST_SIZE - 1]?.cursor ?? undefined;
    hasNextPage = data.data.transactions.pageInfo?.hasNextPage ?? false;
  } while (hasNextPage);

  return {
    interactions,
  };
}

export async function getContractsTransferredToOrControlledByWallet(
  arweave: Arweave,
  params: { address: string },
): Promise<{ ids: string[] }> {
  const { address } = params;
  let hasNextPage = false;
  let cursor: string | undefined;
  const ids = new Set<string>();
  do {
    const queryObject = {
      query: `
          { 
              transactions (
                  tags:[
                    {
                      name: "App-Name",
                      values: ["SmartWeaveAction"]
                    },
                    {
                      name: "Input",
                      values: ${JSON.stringify([
                        // duplicated because the order of the input matters when querying gql
                        {
                          function: 'setController',
                          target: address,
                        },
                        {
                          target: address,
                          function: 'setController',
                        },
                        {
                          function: 'transfer',
                          target: address,
                          qty: 1,
                        },
                        {
                          function: 'transfer',
                          qty: 1,
                          target: address,
                        },
                        {
                          target: address,
                          function: 'transfer',
                          qty: 1,
                        },
                        {
                          target: address,
                          qty: 1,
                          function: 'transfer',
                        },
                        {
                          qty: 1,
                          target: address,
                          function: 'transfer',
                        },
                        {
                          qty: 1,
                          function: 'transfer',
                          target: address,
                        },
                        // removing qty just for coverage
                        {
                          function: 'transfer',
                          target: address,
                        },
                        {
                          target: address,
                          function: 'transfer',
                        },
                      ])
                        .replace(/"/g, '\\"')
                        .replace(/\{/g, '"{')
                        .replace(/\}/g, '}"')}
                   }
                  ],
                  sort: HEIGHT_DESC,
                  first: ${MAX_REQUEST_SIZE},
                  bundledIn: null,
                  ${cursor ? `after: "${cursor}"` : ''}
              ) {
                  pageInfo {
                      hasNextPage
                  }
                  edges {
                      cursor
                      node {
                          id
                          tags {
                            name
                            value
                          }
                          block {
                              height
                          }
                      }
                  }
              }
          }`,
    };

    const { status, ...response } = await arweave.api.post(
      '/graphql',
      queryObject,
    );
    if (status !== 200) {
      throw Error(
        `Failed to fetch contracts for wallet. Status code: ${status}`,
      );
    }

    if (!response.data.data?.transactions?.edges?.length) {
      continue;
    }

    response.data.data.transactions.edges
      .map(
        (e: {
          cursor: string;
          node: { id: string; tags: { name: string; value: string }[] };
          pageInfo?: { hasNextPage: boolean };
        }) => {
          // get the contract id of the interaction
          const contractTag = e.node.tags.find(
            (t: { name: string; value: string }) => t.name === 'Contract',
          );
          // we want to preserve the cursor here, so add even if a duplicate and the set will handle removing the contract if its a duplicate
          return {
            id: contractTag?.value,
            cursor: e.cursor,
            hasNextPage: e.pageInfo?.hasNextPage,
          };
        },
      )
      .forEach((c: { id: string; cursor: string; hasNextPage: boolean }) => {
        ids.add(c.id);
        cursor = c.cursor;
        hasNextPage = c.hasNextPage ?? false;
      });
  } while (hasNextPage);

  return {
    ids: [...ids],
  };
}
