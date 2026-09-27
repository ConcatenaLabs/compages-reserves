# compages-reserves

A public, append-only copy of the signed proof-of-reserves snapshots of
[Compages](https://github.com/ConcatenaLabs/compages), the operator-run bridge
into the Sequentia network from Ethereum and Solana.

Once a day the bridge records, for every asset it has bridged (`USDC.e`,
`EURC.e`, `SOL.s` and the rest), the circulating supply on Sequentia at a
fixed block against the escrow that backs it on the source chains, pinned to
blocks anyone can read again, and signs the record with its attestation key.
Each snapshot carries the hash of the one before it, so the snapshots form a
chain: one that is removed, reordered or rewritten breaks the link of the
next. What each snapshot contains, and how its blocks are chosen, is described
in the Compages README under
["Signed reserve snapshots"](https://github.com/ConcatenaLabs/compages#signed-reserve-snapshots).

This repository keeps those snapshots where the operator cannot quietly change
them. Every hour a GitHub Actions workflow (`.github/workflows/mirror.yml`)
fetches the bridge's index at
`https://sequentiatestnet.com/bridge/api/por/history`, downloads any snapshot
not yet here, and commits it only after checking that it

- is signed by the attestation address pinned in the workflow (`ATTESTER`),
- hashes to what its signature and the index say, and is in canonical form,
- links to the last snapshot already here, and comes after it.

A snapshot already here is never replaced. If the bridge ever lists a
different hash for a height it has already published, or a new snapshot below
the latest one here, the workflow fails and keeps what it has; its history in
the Actions tab and the commit history of `snapshots/` are the public record.
The workflow needs no credentials: it reads a public endpoint and commits with
its own `GITHUB_TOKEN`.

## Attestation address

The bridge signs with

**`SET_ME_TO_THE_ATTESTATION_ADDRESS`**

(placeholder until the bridge's attestation key is generated; the same value
is pinned as `ATTESTER` in `.github/workflows/mirror.yml`, and published in the
Compages README).

## Layout

| Path | What it is |
|---|---|
| `snapshots/<height>.json` | One snapshot, byte for byte as the bridge signed and served it |
| `snapshots/index.json` | Every snapshot here: height, payload hash, the hash it links to, when it was taken |
| `sync.mjs` | The fetch-and-verify step the workflow runs |
| `lib/format.mjs` | The snapshot format and its checks, identical to `reserves/lib/format.mjs` in Compages |
| `test/` | Tests of the mirror's checks (`npm test`) |

## Verifying a snapshot yourself

Each snapshot file is canonical JSON: `{format, version, hash, payload,
signature}`, where `hash` is the sha256 of the payload's canonical JSON and the
signature is an EIP-191 `personal_sign` of

```
Compages proof-of-reserves snapshot
Sequentia height: <height>
Payload sha256: <hash>
```

With nothing but `jq`, `sha256sum` and ethers:

```
jq -cjS .payload snapshots/<height>.json | sha256sum    # equals: jq -r .hash snapshots/<height>.json
node -e 'const {verifyMessage} = require("ethers"); const s = require("./snapshots/<height>.json");
  console.log(verifyMessage(s.signature.message, s.signature.signature))'   # the attestation address
```

The link to the previous snapshot is `payload.previous`: its height, and the
`hash` of that snapshot.

For the whole history at once, and to re-read the figures from the chains
(vault balances at the recorded Ethereum block, the supply at the recorded
Sequentia height), use Compages' verify tool:

```
git clone https://github.com/ConcatenaLabs/compages.git
git clone https://github.com/ConcatenaLabs/compages-reserves.git
cd compages/reserves && npm install
node verify.mjs ../../compages-reserves/snapshots --attester <address>
node verify.mjs ../../compages-reserves/snapshots --attester <address> --rederive --eth-rpc <Sepolia RPC>
```

## License

MIT
