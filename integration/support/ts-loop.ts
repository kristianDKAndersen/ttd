// A single TS writer process that appends `count` items as fast as it can and prints each envelope as one line.
// The crash-recovery test kill -9s it mid-run; an add counts as acknowledged iff its line reached the reader.
import { main } from "../../store-node/cli.ts"

const [prefix = "loop", count = "1000"] = process.argv.slice(2)
for (let i = 1; i <= Number(count); i++) {
  await main(["apply", JSON.stringify({ op: "add", title: `${prefix}-${i}` })], process.env, (l) => process.stdout.write(l + "\n"), (l) => process.stderr.write(l + "\n"))
}
