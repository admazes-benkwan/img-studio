// Copyright 2025 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use server'

import {
  GenerateImageFormI,
  ImagenModelResultI,
  GenerateContentResponse,
  InlineData,
  ImageI,
  GeminiFlashImageRatioToPixel,
  imageGenerationUtils,
} from '../generate-image-utils'
import { decomposeUri, downloadMediaFromGcs, getSignedURL, uploadBase64Image } from '../cloud-storage/action'
import { getFullReferenceDescription } from '../gemini/action'
import { appContextDataI } from '../../context/app-context'
import { EditImageFormI } from '../edit-utils'
const { GoogleAuth } = require('google-auth-library')

function cleanResult(inputString: string) {
  return inputString.toString().replaceAll('\n', '').replaceAll(/\//g, '').replaceAll('*', '')
}

function generateUniqueFolderId() {
  let number = Math.floor(Math.random() * 9) + 1
  for (let i = 0; i < 12; i++) number = number * 10 + Math.floor(Math.random() * 10)
  return number
}

function normalizeSentence(sentence: string) {
  // Split the sentence into individual words
  const words = sentence.toLowerCase().split(' ')

  // Capitalize the first letter of each sentence
  let normalizedSentence = ''
  let newSentence = true
  for (let i = 0; i < words.length; i++) {
    let word = words[i]
    if (newSentence) {
      word = word.charAt(0).toUpperCase() + word.slice(1)
      newSentence = false
    }
    if (word.endsWith('.') || word.endsWith('!') || word.endsWith('?')) {
      newSentence = true
    }
    normalizedSentence += word + ' '
  }

  // Replace multiple spaces with single spaces
  normalizedSentence = normalizedSentence.replace(/  +/g, ' ')

  // Remove any trailing punctuation and spaces
  normalizedSentence = normalizedSentence.trim()

  // Remove double commas
  normalizedSentence = normalizedSentence.replace(/, ,/g, ',')

  return normalizedSentence
}

function generatePrompt(formData: any) {
  let fullPrompt = formData['prompt']

  // Add the photo/ art/ digital style to the prompt
  fullPrompt = `A ${formData['secondary_style']} ${formData['style']} of ` + fullPrompt

  // Add additional parameters to the prompt
  let parameters = ''
  imageGenerationUtils.fullPromptFields.forEach((additionalField) => {
    if (formData[additionalField] !== '')
      parameters += ` ${formData[additionalField]} ${additionalField.replaceAll('_', ' ')}, `
  })
  if (parameters !== '') fullPrompt = `${fullPrompt}, ${parameters}`

  // Add quality modifiers to the prompt for Image Generation
  let quality_modifiers = ''

  if (formData['use_case'] === 'Food, insects, plants (still life)')
    quality_modifiers = quality_modifiers + ', High detail, precise focusing, controlled lighting'

  if (formData['use_case'] === 'Sports, wildlife (motion)')
    quality_modifiers = quality_modifiers + ', Fast shutter speed, movement tracking'

  if (formData['use_case'] === 'Astronomical, landscape (wide-angle)')
    quality_modifiers = quality_modifiers + ', Long exposure times, sharp focus, long exposure, smooth water or clouds'

  fullPrompt = fullPrompt + quality_modifiers

  fullPrompt = normalizeSentence(fullPrompt)

  return fullPrompt
}

export async function buildImageListFromBase64({
  imagesBase64,
  targetGcsURI,
  aspectRatio,
  width,
  height,
  usedPrompt,
  userID,
  modelVersion,
  mode,
}: {
  imagesBase64: ImagenModelResultI[]
  targetGcsURI: string
  aspectRatio: string
  width: number
  height: number
  usedPrompt: string
  userID: string
  modelVersion: string
  mode: string
}) {
  const bucketName = targetGcsURI.replace('gs://', '').split('/')[0]
  let uniqueFolderId = generateUniqueFolderId()
  const folderName = targetGcsURI.split(bucketName + '/')[1] + '/' + uniqueFolderId

  const promises = imagesBase64.map(async (image) => {
    if ('raiFilteredReason' in image) {
      return {
        warning: `${image['raiFilteredReason']}`,
      }
    } else {
      const format = image.mimeType.replace('image/', '').toUpperCase()

      const index = imagesBase64.findIndex((obj) => obj.bytesBase64Encoded === image.bytesBase64Encoded)
      const fileName = 'sample_' + index.toString()

      const fullOjectName = folderName + '/' + fileName + '.' + format.toLocaleLowerCase()

      const ID = fullOjectName
        .replaceAll('/', '')
        .replace(userID, '')
        .replace('generated-images', '')
        .replace('edited-images', '')
        .replace('sample_', '')
        .replace(`.${format.toLowerCase()}`, '')

      const today = new Date()
      const formattedDate = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

      // Store base64 image in GCS, and get signed URL associated
      try {
        let imageGcsUri = ''
        await uploadBase64Image(image.bytesBase64Encoded ?? '', bucketName, fullOjectName).then((result) => {
          if (!result.success) throw Error(cleanResult(result.error ?? 'Could not upload image to GCS'))
          imageGcsUri = result.fileUrl ?? ''
        })

        const signedURL: string | { error: string } = await getSignedURL(imageGcsUri)

        if (typeof signedURL === 'object' && 'error' in signedURL) {
          throw Error(cleanResult(signedURL['error']))
        } else {
          return {
            src: signedURL,
            gcsUri: imageGcsUri,
            format: format,
            prompt: image.prompt && image.prompt != '' ? image.prompt : usedPrompt,
            altText: `Generated image ${fileName}`,
            key: ID,
            width: width,
            height: height,
            ratio: aspectRatio,
            date: formattedDate,
            author: userID,
            modelVersion: modelVersion,
            mode: mode,
          }
        }
      } catch (error) {
        console.error(error)
        return {
          error: 'Error while getting secured access to content.',
        }
      }
    }
  })

  const generatedImagesToDisplay = (await Promise.all(promises)).filter(
    (image) => image !== null
  ) as unknown as ImageI[]

  return generatedImagesToDisplay
}

export async function geminiGenerateImage(
  formData: GenerateImageFormI,
  appContext: appContextDataI | null
) {
  console.log("function geminiGenerateImage invoked.")
  // 1 - Atempting to authent to Google Cloud & fetch project informations
  let client
  try {
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    })
    client = await auth.getClient()
  } catch (error) {
    console.error(error)
    return {
      error: 'Unable to authenticate your account to access images',
    }
  }

  const modelVersion = formData['modelVersion']
  const location = modelVersion.includes('gemini-2.5-flash-image') ? 'us-central1' : process.env.NEXT_PUBLIC_VERTEX_API_LOCATION //Gemini 2.5 Flash Image currently supports only a few regions
  const projectId = process.env.NEXT_PUBLIC_PROJECT_ID
  const geminiAPIurl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelVersion}:generateContent`
  

  // 2 - Building the prompt
  let fullPrompt
  try {
    fullPrompt = generatePrompt(formData)

    if (typeof fullPrompt === 'object' && 'error' in fullPrompt) {
      throw Error(fullPrompt.error)
    }
  } catch (error) {
    console.error(error)
    return {
      error: 'An error occurred while generating the prompt.',
    }
  }

  if (appContext === undefined) throw Error('No provided app context')

  // 3 - Building Gemini 2.5 Flash Image request body
  let generationGcsURI = ''
  if (
    appContext === undefined ||
    appContext === null ||
    appContext.gcsURI === undefined ||
    appContext.userID === undefined
  )
    throw Error('No provided app context')
  else {
    generationGcsURI = `${appContext.gcsURI}/${appContext.userID}/generated-images`
  }
  let reqData: any = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: fullPrompt as string
          }
        ] ,
      },
    ],
    generationConfig: {
      imageConfig: {
        aspectRatio: formData['aspectRatio']
      }
    },
  }

  if (formData['seedNumber']) {
    reqData.generationConfig.seed = parseInt(formData['seedNumber'])
  }

  console.log(reqData)

  const opts = {
    url: geminiAPIurl,
    method: 'POST',
    data: reqData,
  }

  // 4 - Generating images
  try {
    const res = await client.request(opts)

    if (res.data.candidates[0].content === undefined) throw Error('There were an issue, no images were generated')

    const usedRatio = GeminiFlashImageRatioToPixel.find((item) => item.ratio === opts.data.generationConfig.imageConfig.aspectRatio)

    const generateContentResponse: GenerateContentResponse = res.data

    console.log(generateContentResponse)

    let resultImages: ImagenModelResultI[] = [];

    // First, check if the candidates array is not empty to avoid a runtime error
    if (generateContentResponse.candidates && generateContentResponse.candidates.length > 0) {
      // Directly access the parts of the first candidate
      resultImages = generateContentResponse.candidates[0].content.parts
        .filter((part): part is { inlineData: InlineData } => 'inlineData' in part)
        .map(part => ({
          bytesBase64Encoded: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        }));
    }

    let enhancedImageList
    enhancedImageList = await buildImageListFromBase64({
      imagesBase64: resultImages,
      targetGcsURI: generationGcsURI,
      aspectRatio: opts.data.generationConfig.imageConfig.aspectRatio,
      width: usedRatio?.width ?? 0,
      height: usedRatio?.height ?? 0,
      usedPrompt: opts.data.contents[0].parts[0].text,
      userID: appContext?.userID ? appContext?.userID : '',
      modelVersion: modelVersion,
      mode: 'Generated',
    })

    return enhancedImageList
  } catch (error) {
    const errorString = error instanceof Error ? error.toString() : String(error)
    console.error(errorString)

    if (
      errorString.includes('safety settings for peopleface generation') ||
      errorString.includes("All images were filtered out because they violated Vertex AI's usage guidelines") ||
      errorString.includes('Person Generation')
    )
      return {
        error: errorString.replace(/^Error: /i, ''),
      }

    const myError = error as Error & { errors: any[] }
    let myErrorMsg = ''
    if (myError.errors && myError.errors[0] && myError.errors[0].message)
      myErrorMsg = myError.errors[0].message.replace('Image generation failed with the following error: ', '')

    return {
      error: myErrorMsg || 'An unexpected error occurred.',
    }
  }
}

export async function geminiEditImage(formData: EditImageFormI, appContext: appContextDataI | null) {
  console.log("function geminiEditImage invoked.")
  // 1 - Atempting to authent to Google Cloud & fetch project informations
  let client
  try {
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    })
    client = await auth.getClient()
  } catch (error) {
    console.error(error)
    return {
      error: 'Unable to authenticate your account to access images',
    }
  }

  const modelVersion = formData['modelVersion']
  const location = modelVersion.includes('gemini-2.5-flash-image') ? 'us-central1' : process.env.NEXT_PUBLIC_VERTEX_API_LOCATION //Gemini 2.5 Flash Image currently supports only a few regions
  const projectId = process.env.NEXT_PUBLIC_PROJECT_ID
  const geminiAPIurl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelVersion}:generateContent`

  if (appContext === undefined) throw Error('No provided app context')

  // 2 - Building Gemini 2.5 Flash Image request body
  let editGcsURI = ''
  if (
    appContext === undefined ||
    appContext === null ||
    appContext.gcsURI === undefined ||
    appContext.userID === undefined
  )
    throw Error('No provided app context')
  else {
    editGcsURI = `${appContext.gcsURI}/${appContext.userID}/edited-images`
  }

  const refInputImage = formData['inputImage'].startsWith('data:')
    ? formData['inputImage'].split(',')[1]
    : formData['inputImage']

  console.log(formData['inputImage'].split(';')[0].split(':')[1])
    
  const reqData = {
    contents: [
      {
        role: 'user',
        parts: [
          {text: formData.prompt as string},
          {inlineData: {
            mimeType: formData['inputImage'].split(';')[0].split(':')[1],
            data: refInputImage,
            }
          }
        ],
      },
    ],
  }

  console.log(reqData)

  const opts = {
    url: geminiAPIurl,
    method: 'POST',
    data: reqData,
  }

  // 3 - Editing image
  let res
  try {
    res = await client.request(opts)

    if (res.data.candidates[0].content === undefined) {
      throw Error('There were an issue, no images were generated')
    }
    // NO images at all were generated out of all samples
    // if ('raiFilteredReason' in res.data.predictions[0]) {
    //   throw Error(cleanResult(res.data.predictions[0].raiFilteredReason))
    // }
  } catch (error) {
    console.error(error)

    const errorString = error instanceof Error ? error.toString() : ''
    if (
      errorString.includes('safety settings for peopleface generation') ||
      errorString.includes("All images were filtered out because they violated Vertex AI's usage guidelines")
    ) {
      return {
        error: errorString.replace('Error: ', ''),
      }
    }

    const myError = error as Error & { errors: any[] }
    const myErrorMsg = myError.errors[0].message

    return {
      error: myErrorMsg,
    }
  }

  // 4 - Creating output image list
  try {
    const generateContentResponse: GenerateContentResponse = res.data

    console.log(generateContentResponse)

    let resultImages: ImagenModelResultI[] = [];

    // First, check if the candidates array is not empty to avoid a runtime error
    if (generateContentResponse.candidates && generateContentResponse.candidates.length > 0) {
      // Directly access the parts of the first candidate
      resultImages = generateContentResponse.candidates[0].content.parts
        .filter((part): part is { inlineData: InlineData } => 'inlineData' in part)
        .map(part => ({
          bytesBase64Encoded: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        }));
    }

    let enhancedImageList
    enhancedImageList = await buildImageListFromBase64({
      imagesBase64: resultImages,
      targetGcsURI: editGcsURI,
      aspectRatio: formData['ratio'],
      width: formData['width'],
      height: formData['height'],
      usedPrompt: formData.prompt as string,
      userID: appContext?.userID ? appContext?.userID : '',
      modelVersion: modelVersion,
      mode: 'Edited',
    })

    return enhancedImageList
  } catch (error) {
    console.error(error)
    return {
      error: 'Issue while editing image.',
    }
  }
}
