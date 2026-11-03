/** 用无歧义的复合值承载 provider + model；同名模型可跨服务商共存。 */
export const modelChoiceValue = (provider: string, model: string): string =>
  JSON.stringify([provider, model])
