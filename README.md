# Factory Floor Party

A 3D online party game for 2-4 players. Last one standing wins each round.

Minigames (original):
- **Crumbling Floor** - tiles crack where you stand. Keep moving, shove rivals off.
- **Crusher Zone** - red zones mark where a press slams down. Get out in time.

Controls: WASD / arrow keys to move, SPACE to shove. Touch controls appear on phones.

## Run it on your own computer
1. Install Node.js (https://nodejs.org, the LTS version).
2. In this folder run:  `npm install`  then  `npm start`
3. Open http://localhost:3000 - create a room, then open it in a second tab and join with the 4-letter code.

## Put it online (free, no coding)
1. Make a free account at https://github.com and upload this folder as a new repository
   (do not upload the `node_modules` folder).
2. Make a free account at https://render.com, click New > Web Service, pick your repository.
3. Settings: Build Command `npm install`, Start Command `npm start`, Instance type Free.
4. Click Deploy. You get a link like https://your-game.onrender.com - send it to friends.

Note: free Render servers go to sleep when unused, so the first visit can take ~30 seconds to load.

## Files
- `server.js` - the multiplayer server and all game rules
- `public/index.html` - the 3D game in the browser (Three.js)

## Adding a minigame
Add a new entry in `ROUND_PLAN` and `GAME_NAMES` in `server.js`, then add its rules in `updateHazards`.
