
#### GridRenderer Y-coordinate convention — 2026-06-24
- **Context:** GridRenderer and BlockSpawner coordinate system alignment
- **Issue:** GridRenderer uses `y = (display_rows - 1 - row) * tile_size` where row 0 (ground) is at the BOTTOM of the visual grid (highest Y value). Any code that calculates screen-Y for grid positions (e.g., BlockSpawner target_y) must use the same formula, NOT `origin_y - row * cell_size` which inverts the relationship.
- **Solution/Pattern:** Always derive screen position via `grid_origin_y + (display_rows - 1 - row) * cell_size`. Pass `display_rows` from GridManager to any node that needs to compute visual positions.
- **Source:** scripts/game/grid_renderer.gd `_get_tile_position()`, scripts/game/block_spawner.gd `process_blocks()`

#### unique_name_in_owner pattern for @onready %refs — 2026-06-24
- **Context:** Godot 4 @onready with %UniqueName syntax in .tscn scenes
- **Issue:** Adding `@onready var x = %NodeName` in a script without setting `unique_name_in_owner = true` on the corresponding node in the .tscn file causes a null-reference crash on scene load. Every % reference needs a matching unique_name_in_owner entry.
- **Solution/Pattern:** When adding @onready % references, always verify the .tscn has `unique_name_in_owner = true` on that exact node name. Use grep to cross-check both sides.
- **Source:** scenes/game/game.gd, scenes/game/game.tscn

#### Single GridManager source of truth — 2026-06-24
- **Context:** game.tscn had a scene-level GridManager node AND game.gd created GridManager.new() at runtime
- **Issue:** Two GridManager instances causes confusion and potential state divergence. Only one should exist.
- **Solution/Pattern:** Use runtime `GridManager.new()` + `add_child()` in game.gd._init_game(). Remove any scene-level GridManager node from .tscn.
- **Source:** scenes/game/game.tscn, scenes/game/game.gd

#### scenes.gd player path was broken before INT-2 — 2026-06-26
- **Context:** `addons/scene_manager/scenes.gd` auto-generated scene registry
- **Issue:** The "player" entry referenced `res://artifacts/example_3d_fp_controller/scenes/player/player.tscn` but the actual path was `res://root/artifacts/...` (missing `root/` prefix). This entry was already broken before cleanup.
- **Solution/Pattern:** When reviewing scenes.gd entries, verify paths match actual filesystem locations. The addon may generate incorrect paths for deeply nested scenes. Entries referencing deleted scenes should be removed to avoid warnings.
- **Source:** addons/scene_manager/scenes.gd

#### deactivate() must not call remove_child — 2026-06-26
- **Context:** Object pool pattern with LandBlock scenes (block_pool.gd, land_block.gd)
- **Issue:** deactivate() called `get_parent().remove_child(self)` which crashes when the node has no parent (during pool init or after spawner removes it from tree). Also causes double-remove when release() already handles reparenting.
- **Solution/Pattern:** Keep deactivate() as a pure state toggle (visible=false, set_process=false). Let the pool's release() handle reparenting with explicit remove_child + add_child. Never assume a node has a parent in lifecycle methods.
- **Source:** land_block.gd deactivate(), block_pool.gd release()

#### Shadow scale lerp endpoints must differ — 2026-06-26
- **Context:** LandBlock shadow interpolation during falling animation
- **Issue:** `Vector2.ONE.lerp(Vector2(1.0, 1.0), progress)` is a no-op — both endpoints are identical. Shadow appeared at full size throughout the fall.
- **Solution/Pattern:** Always verify lerp endpoints are actually different values. For shadow: `Vector2(0.3, 0.3).lerp(Vector2(1.0, 1.0), progress)` for scale, `lerp(0.2, 0.8, progress)` for alpha.
- **Source:** land_block.gd _update_shadow()

#### Control→Node2D conversion preserves duck-typing via CanvasLayer — 2026-06-26
- **Context:** Converting LandforgerGameContent from Control to Node2D while game_scene.gd uses duck-typed property access
- **Issue:** game_scene.gd checks `"pause_menu_button" in game_content` and accesses `.pause_menu_button.confirmed.connect(...)`. Changing root type from Control to Node2D breaks Control-specific layout but property access still works if vars are defined on the script.
- **Solution/Pattern:** Move UI elements to a CanvasLayer child (layer=10). Keep @onready var references pointing to %UniqueName nodes. Node2D has `visible` and `process_mode` which game_scene.gd also accesses. Set unique_name_in_owner=true on all %referenced nodes in .tscn.
- **Source:** landforger_game_content.gd/.tscn, game_scene.gd

#### deactivate() must not call remove_child — 2026-06-26
- **Context:** Object pool pattern with LandBlock scenes (block_pool.gd, land_block.gd)
- **Issue:** deactivate() called `get_parent().remove_child(self)` which crashes when the node has no parent (during pool init or after spawner removes it from tree). Also causes double-remove when release() already handles reparenting.
- **Solution/Pattern:** Keep deactivate() as a pure state toggle (visible=false, set_process=false). Let the pool's release() handle reparenting with explicit remove_child + add_child. Never assume a node has a parent in lifecycle methods.
- **Source:** land_block.gd deactivate(), block_pool.gd release()

#### Shadow scale lerp endpoints must differ — 2026-06-26
- **Context:** LandBlock shadow interpolation during falling animation
- **Issue:** `Vector2.ONE.lerp(Vector2(1.0, 1.0), progress)` is a no-op — both endpoints are identical. Shadow appeared at full size throughout the fall.
- **Solution/Pattern:** Always verify lerp endpoints are actually different values. For shadow: `Vector2(0.3, 0.3).lerp(Vector2(1.0, 1.0), progress)` for scale, `lerp(0.2, 0.8, progress)` for alpha.
- **Source:** land_block.gd _update_shadow()

#### Control to Node2D conversion preserves duck-typing via CanvasLayer — 2026-06-26
- **Context:** Converting LandforgerGameContent from Control to Node2D while game_scene.gd uses duck-typed property access
- **Issue:** game_scene.gd checks `"pause_menu_button" in game_content` and accesses `.pause_menu_button.confirmed.connect(...)`. Changing root type from Control to Node2D breaks Control-specific layout but property access still works if vars are defined on the script.
- **Solution/Pattern:** Move UI elements to a CanvasLayer child (layer=10). Keep @onready var references pointing to %UniqueName nodes. Node2D has `visible` and `process_mode` which game_scene.gd also accesses. Set unique_name_in_owner=true on all %referenced nodes in .tscn.
- **Source:** landforger_game_content.gd/.tscn, game_scene.gd

#### TileMapLayer z_index with y_sort_enabled parent — 2026-06-27
- **Context:** TerrainRenderer uses TileMapLayer as child of LandforgerGameContent which has y_sort_enabled = true
- **Issue:** When y_sort_enabled is true on a Node2D parent, children are sorted by their y position for rendering order. TileMapLayer renders all its tiles at the node's position, so without explicit z_index it may render on top of other children (like the Player).
- **Solution/Pattern:** Set `z_index = -1` on the TerrainRenderer (or its TileMapLayer child) to guarantee terrain renders behind the player and other game objects. This works regardless of y_sort order.
- **Source:** terrain_renderer.gd _ready()

#### Programmatic TileSet creation from spritesheet — 2026-06-27
- **Context:** Creating a TileSet for TileMapLayer without a .tres resource file
- **Issue:** TileSet .tres files have complex Godot-specific format. Easier to build in GDScript.
- **Solution/Pattern:** Create `TileSet.new()`, set `tile_size`. Create `TileSetAtlasSource.new()`, assign texture, set `texture_region_size`. Call `source.create_tile(atlas_coords)` for each tile. Add source with `tileset.add_source(source, 0)`. Use `tilemap_layer.set_cell(pos, source_id, atlas_coords)` to paint.
- **Source:** terrain_renderer.gd _build_tileset(), _paint_chunk()

#### Spritesheet expansion for new block types — 2026-06-27
- **Context:** Adding Sand as 7th block type when spritesheet had 6 columns
- **Issue:** Spritesheet dimensions must match the number of atlas tiles referenced by BlockTypeEnum values.
- **Solution/Pattern:** Regenerate spritesheet PNG with N+1 columns (32px each) when adding a new BlockType. Update SPRITESHEET_COLS constant in BlockSpawner and TerrainRenderer. BlockTypeEnum int value maps directly to atlas column index.
- **Source:** spritesheet_block_placeholder.png, block_spawner.gd, terrain_renderer.gd

#### Node base type has no `visible` property — 2026-06-27
- **Context:** `BlockSpawner` (extends `Node`) was assigned `.visible = false` in seed map init
- **Issue:** `visible` is a `CanvasItem` property (available on `Node2D`/`Control`), not on plain `Node`. Assigning it triggers a runtime error.
- **Solution/Pattern:** Do not set `.visible` on `Node`-based nodes. For pure-logic spawner/manager nodes, `set_process(false)` + `set_physics_process(false)` is sufficient to disable them.
- **Source:** block_spawner.gd, landforger_game_content.gd:44

#### Raw assets path migration — 2026-06-28
- **Context:** `raw-assets/` directory containing source art was at project root level
- **Issue:** Raw assets at project root are outside the standard `root/assets/` hierarchy, creating inconsistent path organization
- **Solution/Pattern:** Move `raw-assets/` into `root/assets/raw-assets/` and update all `res://raw-assets/` references to `res://root/assets/raw-assets/` in GDScript constants, doc files, and `.import` source_file entries
- **Source:** tools/build_block_assets.gd, docs/features/f13_final_block_sprites.md
