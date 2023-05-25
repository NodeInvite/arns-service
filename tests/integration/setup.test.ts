import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet.js";
import * as fs from "fs";
import path from "path";
import { LoggerFactory, WarpFactory } from "warp-contracts";
import { DeployPlugin } from "warp-contracts-plugin-deploy";

const ARWEAVE_PORT = process.env.ARWEAVE_PORT ?? 1984;
const ARWEAVE_HOST = process.env.ARWEAVE_HOST ?? "127.0.0.1";
// Arweave
export const arweave = Arweave.init({
  host: ARWEAVE_HOST,
  port: ARWEAVE_PORT,
  protocol: "http",
});
// Warp
export const warp = WarpFactory.forLocal(+ARWEAVE_PORT, arweave).use(
  new DeployPlugin()
);
LoggerFactory.INST.logLevel("info");

// start arlocal
console.log("Setting up Warp, Arlocal and Arweave clients!");
export async function mochaGlobalSetup() {
  // create directories used for tests
  ["./wallets", "./contracts"].forEach((dir) =>
    fs.mkdirSync(path.join(__dirname, dir))
  );

  // create a wallet and add some funds
  const { wallet, address } = await createLocalWallet(arweave);

  // TODO: set env var to wallet address
  process.env.PRIMARY_WALLET_ADDRESS = address;

  const contractSrcJs = fs.readFileSync(
    path.join(__dirname, "./arlocal/index.js"),
    "utf8"
  );

  const initState = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "./arlocal/initial-state.json"),
      "utf8"
    )
  );

  // deploy contract to arlocal
  const { contractTxId } = await warp.deploy(
    {
      wallet,
      initState: JSON.stringify({
        ...initState,
        owner: address,
        controller: address,
        balances: {
          [address]: 1,
        },
      }),
      src: contractSrcJs,
    },
    true // disable bundling
  );

  // set in the environment
  process.env.DEPLOYED_CONTRACT_TX_ID = contractTxId;
  console.log(
    "Successfully setup ArLocal and deployed contract.",
    contractTxId
  );
}

// can be async or not
export async function mochaGlobalTeardown() {
  removeDirectories();
  console.log("Test finished!");
}

function removeDirectories() {
  ["./wallets", "./contracts"].forEach((dir) =>
    fs.rmSync(path.join(__dirname, dir), { recursive: true })
  );
}

async function createLocalWallet(
  arweave: Arweave,
  amount: number = 10_000_000_000_000
): Promise<{ wallet: JWKInterface; address: string }> {
  // ~~ Generate wallet and add funds ~~
  const wallet = await arweave.wallets.generate();
  const address = await arweave.wallets.jwkToAddress(wallet);
  // mint some tokens
  await arweave.api.get(`/mint/${address}/${amount}`);
  return {
    wallet,
    address,
  };
}
