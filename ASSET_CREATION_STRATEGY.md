# Asset Creation Strategy Integration

## Overview
This document describes the implementation of Claude's asset creation strategy, which prioritizes using external asset libraries (PolyHaven, Sketchfab, Hyper3D) before falling back to manual code generation.

## Implementation Details

### 1. Integration Status Checking
The system now checks for available integrations before attempting asset creation:
- **PolyHaven**: For generic objects, textures, and HDRIs
- **Sketchfab**: For realistic models and specific objects
- **Hyper3D/Rodin**: For custom/unique items and AI-generated models

### 2. Asset Creation Strategy Analysis
The `analyzeAssetCreationStrategy()` function analyzes the user prompt to determine:
- Which asset sources to try
- Priority order for attempting each source
- Asset type (model, texture, HDRI, material)

**Strategy Rules:**
- **Specific objects** (chair, table, furniture): Try Sketchfab first, then PolyHaven
- **Generic objects** (cube, sphere, ground): Try PolyHaven first, then Sketchfab
- **Custom/unique items** (realistic rabbit, high-detail animals): Try Hyper3D first, then Sketchfab/PolyHaven
- **Environment/lighting**: Use PolyHaven HDRIs
- **Materials/textures**: Use PolyHaven textures

### 3. Asset Creation Workflow
The `executeAssetCreationWorkflow()` function implements the following workflow:

1. **Check scene info** - Always starts by getting current scene context
2. **Analyze strategy** - Determines which assets to try based on prompt
3. **Check integrations** - Verifies which integrations are available
4. **Try assets in priority order**:
   - Sketchfab: Search for models, download if available
   - PolyHaven: Download models, textures, or HDRIs
   - Hyper3D: Generate model via text or images
5. **Fall back to manual code** - If all asset methods fail or are unavailable

### 4. Post-Processing
When an asset is successfully imported:
- Generate post-processing code to:
  - Check `world_bounding_box` of imported object
  - Scale to match specified dimensions
  - Position appropriately in scene
  - Adjust rotation if needed
  - Apply materials/textures
  - Ensure proper spatial relationships
  - Check for clipping issues

### 5. Hyper3D Workflow
For Hyper3D generation:
- Uses `generate_hyper3d_model_via_text()` for text prompts
- Uses `generate_hyper3d_model_via_images()` when images are provided
- Polls job status until completion (max 120 seconds)
- Imports generated asset
- Handles free trial limit errors with helpful messages
- Generates post-processing code for positioning/scaling

### 6. Spatial Relationship Checking
After importing any asset:
- Get `world_bounding_box` of imported object
- Adjust location, scale, and rotation based on bounding box
- Ensure objects are properly positioned relative to each other
- Check for clipping and adjust accordingly

## Usage Flow

### Example 1: Realistic Rabbit (Hyper3D)
```
Prompt: "Generate a highly detailed, high-polygon 3D model of a realistic rabbit..."
```

1. Strategy: `analyzeAssetCreationStrategy()` detects "highly detailed", "realistic", "rabbit"
2. Priority: `['hyper3d', 'sketchfab', 'polyhaven_model']`
3. Workflow:
   - Check Hyper3D status → Available
   - Generate Hyper3D model via text
   - Poll until completion
   - Import asset
   - Generate post-processing code for scaling/positioning
   - Execute post-processing code

### Example 2: Chair (Sketchfab)
```
Prompt: "Create a chair in the scene"
```

1. Strategy: Detects "chair" as specific object
2. Priority: `['sketchfab', 'polyhaven_model']`
3. Workflow:
   - Check Sketchfab status → Available
   - Search Sketchfab for "chair"
   - Download first downloadable model
   - Generate post-processing code
   - Execute post-processing code

### Example 3: Ground Plane (Manual Code)
```
Prompt: "Create a ground plane"
```

1. Strategy: Detects "ground", "plane" as generic object
2. Priority: `['polyhaven_model', 'sketchfab']`
3. Workflow:
   - Check PolyHaven → Not available or no suitable asset
   - Check Sketchfab → Not available or no suitable asset
   - Fall back to manual code generation
   - Generate Blender Python code to create plane

## Error Handling

### Free Trial Limit
When Hyper3D free trial key hits daily limit:
- Error message includes helpful guidance:
  - Wait for another day
  - Get API key from hyper3d.ai
  - Get private API key from fal.ai
- Falls back to Sketchfab/PolyHaven or manual code

### Integration Unavailable
If an integration is not available:
- Logs warning message
- Continues to next method in priority list
- Falls back to manual code if all methods fail

### Asset Import Failure
If asset import fails:
- Logs error message
- Continues to next method
- Falls back to manual code generation

## System Prompt Updates

The system prompt now includes:
- Instructions to use asset libraries when available
- Guidelines for post-processing imported assets
- Emphasis on checking `world_bounding_box`
- Spatial relationship checking requirements
- Hyper3D-specific guidelines (single items only, no scenes/ground)

## API Response Updates

The API response now includes:
- `assetMethod`: Which method was used ('polyhaven', 'sketchfab', 'hyper3d', 'manual')
- `assetUsed`: Boolean indicating if an asset was used
- `assetStrategy`: The analyzed strategy object (in debug mode)

## Future Enhancements

1. **PolyHaven Search**: Implement search/browse functionality for PolyHaven assets
2. **Asset Reuse**: Implement asset duplication for previously generated models
3. **Bounding Box Automation**: Automatically adjust position/scale based on bounding box
4. **Asset Quality Scoring**: Score assets and choose best match
5. **Multi-Asset Scenes**: Handle multiple assets in a single request

## Testing

To test the asset creation strategy:
1. Use prompts that trigger different strategies
2. Check backend logs for integration status
3. Verify asset import and post-processing
4. Test fallback to manual code when assets unavailable
5. Test Hyper3D free trial limit handling

## Notes

- The system always checks scene info first
- Assets are tried in priority order
- Manual code generation is only used as last resort
- Post-processing code always checks bounding boxes
- Spatial relationships are verified after asset import

