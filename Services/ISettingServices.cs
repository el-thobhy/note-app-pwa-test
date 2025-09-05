using ELAuth.ViewModel;
using NoteAppPWA.Models;

namespace NoteAppPWA.Services
{
    public interface ISettingServices
    {
        Task<LoginResponseViewModel> UpdateFirstLast(UpdateViewModel request, string userName);
        Task<LoginResponseViewModel> UpdateProfilePhoto(string id, string userName, IFormFile file);
    }
}
