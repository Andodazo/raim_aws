exports.handler = async (event) => {
  if (event.triggerSource === "PreSignUp_ExternalProvider") {
    throw new Error("New OAuth users are not allowed.");
  }

  return event;
};
