/**
 * Lightning Returns Configuration.ini / Environment.ini writer.
 *
 * LR reads its graphics/control/audio settings from these INI files in the
 * Steam userdata config dir (unlike XIII/XIII-2 which take launch-arg flags).
 * Mirrors AppSettings.WriteLRConfig — section 'Configuration' for graphics +
 * confirm-button, section 'Environment' for voice language. Values are the
 * game's expected mapping strings.
 */
export interface LrConfig {
  presentation?: string; // Graphics_Presentation (e.g. 'Windowed'/'Fullscreen')
  resolution?: string; // 'WIDTHxHEIGHT'
  scaling?: string;
  colorCorrection?: string;
  glare?: string;
  depthOfField?: string;
  shadowing?: string;
  lighting?: string;
  textureFiltering?: string;
  frameRate?: string;
  confirmButtonLayout?: string;
  voiceLanguage?: string;
}

function iniSection(section: string, kv: Record<string, string | undefined>): string {
  const lines = [`[${section}]`];
  for (const [k, v] of Object.entries(kv)) {
    if (v !== undefined && v !== '') lines.push(`${k}= ${v}`); // leading space matches Nova's INI writer
  }
  return lines.join('\r\n') + '\r\n';
}

/** Build the LR Configuration.ini contents. */
export function buildLrConfigurationIni(c: LrConfig): string {
  return iniSection('Configuration', {
    Graphics_Presentation: c.presentation,
    Graphics_Resolution: c.resolution,
    Graphics_Scaling: c.scaling,
    Graphics_ColorCorrection: c.colorCorrection,
    Graphics_Glare: c.glare,
    Graphics_DepthOfField: c.depthOfField,
    Graphics_Shadowing: c.shadowing,
    Graphics_Lighting: c.lighting,
    Graphics_TextureFiltering: c.textureFiltering,
    Graphics_FrameRate: c.frameRate,
    Control_ConfirmButtonLayout: c.confirmButtonLayout,
  });
}

/** Build the LR Environment.ini contents. */
export function buildLrEnvironmentIni(c: LrConfig): string {
  return iniSection('Environment', { VoiceLanguage: c.voiceLanguage });
}
