# Atoms!

A browser remake of the classic chain-reaction strategy game *Atoms*, made for phones in portrait mode as well as desktop screens.

To play on one device, open `index.html` in any modern browser. Nothing needs installing or building.

## Playing across computers

To play with people on other computers on the same network, run the included server. It needs [Node.js](https://nodejs.org/) 18 or newer and has no other dependencies.

```bash
node server.js
```

It prints the addresses to use, for example `http://192.168.1.20:8080`. Set the `PORT` environment variable to use a different port.

1. Open the game from that address and choose **New game → Network**.
2. Set your own colours to **You** and the rest to **CPU**, then press **Start & invite**.
3. Send the link it shows. Anyone who opens it picks a CPU colour to take over, or watches.

Other notes:

- Players can tap the colour chips at any time to take a free seat or hand theirs back to the CPU.
- If a player is offline for 30 seconds, the CPU takes over their colour until someone takes the seat again.
- Only the host can start a rematch.
- Games are kept in memory, so restarting the server ends them.
- The first time you run the server, Windows may ask whether Node.js may accept connections on your network. Allow it for private networks, or other computers can't connect.

## How to play

- 2 to 4 players. Each colour can be a human, the CPU, or switched off.
- On your turn, tap an empty square or one of your own squares to add an atom.
- A square explodes when it holds as many atoms as it has neighbours: 2 in a corner, 3 on an edge, 4 in the middle.
- When a square explodes, each neighbouring square gets one atom and turns your colour. That can make it explode too, so chains follow.
- The last colour left on the grid wins.

Keyboard: the arrow keys move the cursor and Enter places an atom.

## CPU levels

The page opens with you against one Med CPU. Press **New game** to add up to three CPU players and pick a level for each one. The setup screen also explains the levels, so you can mix them, for example one Low and one High.

| Level | How it plays | Good for |
| --- | --- | --- |
| **Low** | Mostly random. Now and then it takes the move that wins the most atoms at once, but it never notices danger. | Learning the rules |
| **Med** (default) | Picks the move that looks best right now and prefers corners and edges. It doesn't think about your reply, so it walks into traps. | Most players |
| **High** | Tries every move against your strongest reply and avoids squares you could blow up. Leave it an opening and it starts a chain. | A real challenge |

In test games between CPUs, High beat Med and Med beat Low over 90% of the time.

## Credits

This is a fan-made tribute. The game design belongs to the original authors:

- **Atari ST original:** *Atoms* by **B. Hewlett**. A freeware game for the Atari ST, for 2 to 4 players with the mouse, catalogued around 1989.
  ([AtariUpToDate](https://www.atariuptodate.de/en/12186/atoms))
- **Amiga version:** *Atoms* by **Tom Kuhn**. Written in 68000 assembly and based on the ST version by B. Hewlett. Spread through the Amiga PD scene and on Amiga Format cover disk 46.
  ([Aminet](https://aminet.net/package/game/2play/atoms))
- **Another Amiga conversion:** *Atoms* by **John Girvin** (1992), a separate conversion of the same ST game, later released as open source.
  ([Aminet](https://aminet.net/package/game/think/atoms_halibut))

This remake is new code and graphics, written from the published rules. It uses no original code or artwork.

Fonts: [Bricolage Grotesque](https://fonts.google.com/specimen/Bricolage+Grotesque) and [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono), loaded from Google Fonts.
