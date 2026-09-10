// Owner-approved presets. Shared by the scene and every character reference.
export const IMAGE_PROMPTS = {
  cartoon: `Highly polished 2D cartoon with anime influence.
Clearly stylized, not semi-realistic.

Use simplified facial planes, smooth clean linework, soft cel shading,
slightly exaggerated expressions, larger expressive eyes,
and gently simplified nose and mouth shapes.

Make the characters look unmistakably cartooned,
while preserving recognizable likeness.

Preserve the person's identity through:
face shape, jawline, cheek structure, eye shape and spacing,
eyebrow shape, nose silhouette, mouth proportions,
hairstyle, hairline, skin tone, age and distinctive facial features.

Stylize the rendering more than the facial geometry.
Do not replace the person with a generic anime character.
Do not make adults look younger than their real age.
No chibi proportions, no tiny button nose, no extreme baby face,
no excessively round head, no huge eyes that distort identity.`,
  realistic: 'Use a polished, semi-realistic anime-inspired style with soft, appealing rendering. Preserve each person’s facial geometry, proportions, age, and distinctive features. Stylize the rendering, not the identity. Avoid oversized eyes, shortened noses, rounded baby-face proportions, chibi traits, or generic anime facial features.',
} as const;

export const CLOTHING_PROMPT = 'Clothing: If any visible bottoms look like underwear, replace them with short shorts or fitted shorts that are slightly longer, while keeping the original color, style and design as similar as possible. Leave all other clothing unchanged.';
